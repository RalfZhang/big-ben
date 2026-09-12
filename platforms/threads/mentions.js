/**
 * 被 at 时自动回复当前时间 —— 可选功能，整份实现只在这一个文件里。
 *
 * 不想要了，两步删干净：
 *   1. 删掉本文件
 *   2. 删掉根目录 index.js 末尾那段带「被 at 自动回复」注释的 import 和调用
 * config.js 里的 threads.mentions 块、data/threads-mentions.json 留着也无害。
 * 同目录 index.js 里为它开的 graph / owner / publish 三个 export 不用动 ——
 * publish() 是从 post() 里抽出来的，post() 自己还在用。
 *
 * 为什么用轮询不用 webhook：webhook 要公网 HTTPS 端点 + 签名校验 + 重试去重，
 * 而这个进程本来就没有入口。轮询的延迟上界就是 pollSeconds，反而可预测；
 * 配额也不紧张 —— Threads 通用限额至少 48000 次/24h，60 秒一轮只花掉 1440 次。
 *
 * 前置权限：threads_basic + threads_manage_mentions。没拿到 Advanced Access 之前，
 * /mentions 只返回 App Roles 里 Threads tester 发的 at，陌生人的 at 一条都查不到 ——
 * 那时候日志会一直是 0 条，这是正常现象，不是这里坏了。
 */
import fs from 'node:fs';
import path from 'node:path';

import config from '../../config.js';
import { log, describeError } from '../../lib/log.js';
import { now } from '../../lib/text.js';
import threads, { graph, owner, publish, tokenScopes } from './index.js';

const cfg = (config.threads || {}).mentions || {};

export const STATE_FILE = process.env.THREADS_MENTIONS_FILE
  || new URL('../../data/threads-mentions.json', import.meta.url).pathname;

// 每轮都往回多看 5 分钟：一条 at 不是发出来就立刻能查到，索引有滞后。
// 只按上次的时间点往后拉，正好卡在滞后里的那条会被永久跳过。
// 重叠的代价只是每轮多返回几条已处理的，seen 去重挡掉。
const OVERLAP_SEC = 300;

// Threads 上线时间。API 规定 since 不能早于它，早了直接 400
const EPOCH_SEC = 1688540400;

// 字段要少 —— 每多一个字段就多一种 400 的可能。permalink 纯粹为了日志里能点开看一眼
const FIELDS = 'id,text,username,timestamp,permalink';

// seen 只需要盖住 OVERLAP_SEC 这个窗口，200 条对一个报时号绰绰有余
const SEEN_MAX = 200;

// 连着失败这么多次就放弃这条。对方把回复权限设成「仅关注者」之类是死局，
// 再试多少次都是同一个结果，不如把配额留给下一条
const MAX_FAILS = 3;

// 没有它 /mentions 一定失败，而且失败得毫无信息量（见 index.js 的 tokenScopes 注释）
const REQUIRED_SCOPE = 'threads_manage_mentions';

// 连续失败时退避的上限。15 秒一轮撞一个修不好的错，一天能刷出 5760 行 WARN，
// 把日志里真正要紧的东西冲掉
const MAX_BACKOFF_SEC = 600;

const pollSec = Math.max(15, Number(cfg.pollSeconds) || 60);
const maxAgeSec = Math.max(60, (Number(cfg.maxAgeMinutes) || 30) * 60);
const cooldownSec = Math.max(0, Number(cfg.userCooldownSeconds ?? 120));
// Threads 的硬限额是 1000 条回复/24h，默认只用五分之一，剩下的留给整点报时和手抖
const dailyCap = Math.max(1, Number(cfg.dailyCap) || 200);

function emptyState() {
  return { since: 0, seen: [], failed: {}, users: {}, day: '', dayCount: 0 };
}

function readState() {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch (err) {
    // 文件不存在是第一次跑，正常；坏了就当全新状态重来 ——
    // 大不了漏回几条，总比每轮崩在这里强
    if (err.code !== 'ENOENT') log.warn(`${STATE_FILE} 读不出来，当成全新状态：${err.message}`);
    return emptyState();
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// 自己 at 自己不回 —— 否则回复文案里但凡带上 @自己 就是个死循环。
// threads.js 的 init() 查过一次 username 但没留下来，这里自己查一次，缓存到进程结束
let selfName = null;
async function whoami() {
  if (selfName) return selfName;
  const me = await graph(`/${owner}`, { form: { fields: 'username' } });
  selfName = String(me.username || '').toLowerCase();
  log.info(`mentions: watching @${selfName}`);
  return selfName;
}

// 回复文案。想换成整点那套 getText()，改这一个函数就行。
// Threads 单条上限 500 字符，别写太长
function replyText(at = now()) {
  return `咣！${threads.brand}大笨钟提醒您：现在是北京时间 ${at.format('YYYY-MM-DD HH:mm:ss')}。`;
}

// 所有「不回」的理由集中在这里，日志里一眼能看出是哪条规则挡的。返回 null 表示该回
function skipReason(m, state, self, nowSec) {
  const username = String(m.username || '');
  if (username.toLowerCase() === self) return '自己发的';

  const ts = Date.parse(m.timestamp);
  if (!Number.isFinite(ts)) return `timestamp 解析不了（${m.timestamp}）`;

  const age = nowSec - Math.floor(ts / 1000);
  // 停机一天再回来，把积压的几十条全回一遍「当前时间」，既是刷屏也是烧配额
  if (age > maxAgeSec) return `太旧了（${Math.round(age / 60)} 分钟前）`;

  if (state.dayCount >= dailyCap) return `今天已回 ${state.dayCount} 条，到上限了`;

  const last = state.users[username] || 0;
  if (nowSec - last < cooldownSec) return `@${username} 还在 ${cooldownSec}s 冷却里`;

  return null;
}

// state 不能无限长：seen 只留最近 SEEN_MAX 条；users 丢掉已经出冷却的；
// failed 丢掉这轮窗口里已经查不到的 —— 窗口滑过去了，那条 id 再也不会回来
function prune(state, batchIds, nowSec) {
  state.seen = state.seen.slice(-SEEN_MAX);
  for (const [name, ts] of Object.entries(state.users)) {
    if (nowSec - ts > cooldownSec) delete state.users[name];
  }
  for (const id of Object.keys(state.failed)) {
    if (!batchIds.has(id)) delete state.failed[id];
  }
  return state;
}

async function poll() {
  const state = readState();
  const at = now();
  const nowSec = Math.floor(at.valueOf() / 1000);

  // 日上限按北京时间的自然日算，跟报时的时区保持一致
  const today = at.format('YYYY-MM-DD');
  if (state.day !== today) {
    state.day = today;
    state.dayCount = 0;
  }

  // 第一次跑没有 state，就从「刚才」开始，不翻历史 ——
  // 几小时前的 at 现在回一个当前时间没有任何意义
  const since = Math.max(EPOCH_SEC, state.since || (nowSec - OVERLAP_SEC));

  const body = await graph(`/${owner}/mentions`, {
    form: { fields: FIELDS, since: String(since) },
  });
  const items = Array.isArray(body.data) ? body.data : [];

  const self = await whoami();
  const seen = new Set(state.seen);
  const batchIds = new Set(items.map((m) => m.id));

  // 按时间正序处理：先来的先回，日志读起来也跟时间线一致
  items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  let replied = 0;
  let skipped = 0;
  let fresh = 0;

  for (const m of items) {
    if (!m.id || seen.has(m.id)) continue;
    fresh += 1;

    const reason = skipReason(m, state, self, nowSec);
    if (reason) {
      log.debug(`mentions: skip ${m.id} by @${m.username} —— ${reason}`);
      seen.add(m.id);
      skipped += 1;
      continue;
    }

    try {
      // publish() 内部已经处理了 container 未就绪（code 24）的等待和重试
      const id = await publish({
        media_type: 'TEXT',
        text: replyText(now()),
        reply_to_id: m.id,
      });
      log.info(`mentions: replied to @${m.username} ${m.permalink || m.id} (id=${id ?? '-'})`);
      seen.add(m.id);
      delete state.failed[m.id];
      state.users[String(m.username || '')] = nowSec;
      state.dayCount += 1;
      replied += 1;
    } catch (err) {
      // 这里不重试：下一轮 poll 就是重试，窗口还盖得住它。
      // 失败的不进 seen，攒够 MAX_FAILS 次才放弃
      const n = (state.failed[m.id] || 0) + 1;
      state.failed[m.id] = n;
      log.warn(`mentions: reply to ${m.id} failed ${n}/${MAX_FAILS}: ${describeError(err)}`);
      if (n >= MAX_FAILS) {
        log.error(`mentions: 放弃 ${m.id}（@${m.username}），连续失败 ${MAX_FAILS} 次`);
        seen.add(m.id);
        delete state.failed[m.id];
      }
    }
  }

  state.seen = [...seen];
  // 无论这轮有没有货，窗口都往前推：下轮固定看最近 OVERLAP_SEC 秒
  state.since = nowSec - OVERLAP_SEC;
  writeState(prune(state, batchIds, nowSec));

  const line = `mentions: ${items.length} in window, ${fresh} new, ${replied} replied, ${skipped} skipped`;
  if (replied || skipped) log.info(line);
  else log.debug(line);
}

// 启动自检：token 里没有 threads_manage_mentions 的话，/mentions 每次都会回
// HTTP 500 code 1，字面上看不出任何原因。与其让它每 pollSeconds 撞一次墙，
// 不如开跑前问清楚，把该做什么直接写进日志，然后停掉 —— 这个是重新生成 token
// 才能修的，光等下一轮没有意义
let preflighted = false;
async function preflight() {
  if (preflighted) return true;

  const scopes = await tokenScopes();
  if (!scopes.includes(REQUIRED_SCOPE)) {
    log.error(`mentions watcher 停了：token 里没有 ${REQUIRED_SCOPE}，/mentions 调不动。`);
    log.error(`  这个 token 现有权限：${scopes.join(', ') || '（一个都没查到）'}`);
    // 后台那个 Generate Access Token 按钮在这里帮不上忙 —— 它发的 scope 是写死的
    // 首发五件套，无论 use case 里加了什么都一样。只能走 OAuth 显式要这个 scope
    log.error('  注意：后台的 Generate Access Token 按钮拿不到这个权限，'
      + '它发的 scope 是固定的（basic / content_publish / manage_replies / read_replies / manage_insights）。');
    log.error('  修法：本机跑 npm run threads:auth 走一次 OAuth 授权，'
      + '它会把带全权限的 token 写进 data/threads-token.json，然后重启。详见 deploy.md。');
    return false;
  }

  preflighted = true;
  log.info(`mentions: token 权限齐了（${scopes.join(', ')}）`);
  return true;
}

let running = false;
let timer = null;
// 连续失败就拉长间隔，恢复后立刻归零
let failStreak = 0;
let nextAttemptAt = 0;

async function tick() {
  // 上一轮还没跑完就跳过这轮 —— 回复要等 container 就绪，慢的时候几十秒，
  // 两轮叠在一起会各自读到同一份 state 再写回，后写的把先写的覆盖掉
  if (running) {
    log.debug('mentions: previous tick still running, skip');
    return;
  }
  // ready 由 index.js 维护（init 失败它会在下个整点重登）。这里只跟随不自己 init，
  // 免得跟它抢着刷 token —— 两边同时 refresh 会把彼此换出来的 token 作废
  if (!threads.ready) {
    log.debug('mentions: threads not ready, skip');
    return;
  }

  if (Date.now() < nextAttemptAt) return;

  running = true;
  try {
    // 自检不过就别再跑了 —— 它只会每轮复读同一个查不出原因的 500
    if (!await preflight()) {
      clearInterval(timer);
      timer = null;
      return;
    }
    await poll();
    if (failStreak) {
      log.info(`mentions: 恢复正常（之前连续失败 ${failStreak} 次）`);
      failStreak = 0;
    }
  } catch (err) {
    // 一轮失败不值得惊动进程，下一轮就是重试；但连着失败就把间隔拉长，别刷屏
    failStreak += 1;
    const backoff = Math.min(pollSec * 2 ** failStreak, MAX_BACKOFF_SEC);
    nextAttemptAt = Date.now() + backoff * 1000;
    log.warn(`mentions poll failed (第 ${failStreak} 次，${backoff}s 后再试): ${describeError(err)}`);
  } finally {
    running = false;
  }
}

export function startMentionWatcher() {
  if (!cfg.enabled) {
    log.info('mentions watcher off（config.threads.mentions.enabled 没开）');
    return null;
  }
  if (!threads.enabled) {
    log.warn('mentions watcher 要用 threads 平台，但 config.threads.enabled 是 false，不启动');
    return null;
  }

  log.info(`mentions watcher on: 每 ${pollSec}s 拉一次，只回 ${Math.round(maxAgeSec / 60)} 分钟内的 at，`
    + `同一人 ${cooldownSec}s 冷却，每天最多 ${dailyCap} 条`);

  // 故意不 unref：这个定时器 ref 住进程是好事，万一 node-schedule 那边出意外，
  // 至少进程还在，日志还在走
  timer = setInterval(tick, pollSec * 1000);
  tick();   // 启动就先拉一轮，不用干等第一个 pollSec
  return timer;
}
