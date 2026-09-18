/**
 * 被 at 时自动回复当前时间。可选功能，整份实现只在这一个文件里
 * （删掉本文件 + 根目录 index.js 里那两行即可）。
 *
 * 跟 reply.js 的分工：这个查 /mentions（别人 @ 我），那个翻自己帖子的 /conversation。
 * 「在我帖子底下回复又打了 @」两边都会看到，靠 replied.js 判重，配额也共用（quota.js）。
 *
 * 用轮询不用 webhook：进程本来就没有公网入口，而延迟上界就是 pollSeconds，反而可预测。
 *
 * 需要 threads_manage_mentions。没拿到 Advanced Access 之前只能查到 Threads tester
 * 发的 at，日志一直是 0 条属于正常（详见 deploy.md）。
 */
import fs from 'node:fs';
import path from 'node:path';

import config from '../../config.js';
import { log, describeError } from '../../lib/log.js';
import { clockText, now } from '../../lib/text.js';
import threads, { graph, owner, publish, tokenScopes, whoami } from './index.js';
import { replyBudgetLeft, spendReplyBudget } from './quota.js';
import { hasReplied, markReplied } from './replied.js';

const cfg = (config.threads || {}).mentions || {};

export const STATE_FILE = process.env.THREADS_MENTIONS_FILE
  || new URL('../../data/threads-mentions.json', import.meta.url).pathname;

// 每轮往回多看 5 分钟：索引有滞后，只按上次时间点往后拉的话，
// 正好卡在滞后里的那条会被永久跳过。重叠的代价由 seen 去重挡掉
const OVERLAP_SEC = 300;

// Threads 上线时间，since 早于它会被直接 400
const EPOCH_SEC = 1688540400;

// 字段越少 400 的可能越少。permalink 纯粹为了日志里能点开看一眼
const FIELDS = 'id,text,username,timestamp,permalink';

// seen 只需要盖住 OVERLAP_SEC 这个窗口
const SEEN_MAX = 200;

// 连着失败这么多次就放弃这条 —— 对方把回复权限设成「仅关注者」之类是死局
const MAX_FAILS = 3;

// 没有它 /mentions 一定失败，而且失败得毫无信息量（见 index.js 的 tokenScopes）
const REQUIRED_SCOPE = 'threads_manage_mentions';

// 连续失败时的退避上限。15 秒一轮撞一个修不好的错，一天能刷出 5760 行 WARN
const MAX_BACKOFF_SEC = 600;

const pollSec = Math.max(15, Number(cfg.pollSeconds) || 60);
const maxAgeSec = Math.max(60, (Number(cfg.maxAgeMinutes) || 30) * 60);
const cooldownSec = Math.max(0, Number(cfg.userCooldownSeconds ?? 120));
// 本功能自己的日上限，真正的硬闸门在 ./quota.js
const dailyCap = Math.max(1, Number(cfg.dailyCap) || 200);

function emptyState() {
  return { since: 0, seen: [], failed: {}, users: {}, day: '', dayCount: 0 };
}

function readState() {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch (err) {
    // 坏了就当全新状态重来，大不了漏回几条，总比每轮崩在这里强
    if (err.code !== 'ENOENT') log.warn(`${STATE_FILE} 读不出来，当成全新状态：${err.message}`);
    return emptyState();
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// 所有「不回」的理由集中在这里，日志里一眼看出是哪条规则挡的。null 表示该回
function skipReason(m, state, self, nowSec, budget) {
  const username = String(m.username || '');
  if (username.toLowerCase() === self) return '自己发的';

  if (hasReplied(m.id)) return '别处已经回过了（共享账本）';

  const ts = Date.parse(m.timestamp);
  if (!Number.isFinite(ts)) return `timestamp 解析不了（${m.timestamp}）`;

  // 停机一天再回来，把积压的几十条全回一遍「当前时间」，既是刷屏也是烧配额
  const age = nowSec - Math.floor(ts / 1000);
  if (age > maxAgeSec) return `太旧了（${Math.round(age / 60)} 分钟前）`;

  if (state.dayCount >= dailyCap) return `今天已回 ${state.dayCount} 条，到本功能上限了`;
  if (budget !== null && budget <= 0) return '24 小时回复配额用完了（含预留）';

  const last = state.users[username] || 0;
  if (nowSec - last < cooldownSec) return `@${username} 还在 ${cooldownSec}s 冷却里`;

  return null;
}

// state 不能无限长。failed 丢掉这轮窗口里查不到的 —— 窗口滑过去了，那条 id 不会再回来
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

  // 日上限按北京时间的自然日算，跟报时的时区一致
  const today = at.format('YYYY-MM-DD');
  if (state.day !== today) {
    state.day = today;
    state.dayCount = 0;
  }

  // 第一次跑没有 state 就从「刚才」开始 —— 几小时前的 at 现在回个当前时间没意义
  const since = Math.max(EPOCH_SEC, state.since || (nowSec - OVERLAP_SEC));

  const body = await graph(`/${owner}/mentions`, {
    form: { fields: FIELDS, since: String(since) },
  });
  const items = Array.isArray(body.data) ? body.data : [];

  const self = await whoami();
  const seen = new Set(state.seen);
  const batchIds = new Set(items.map((m) => m.id));

  // 正序处理：先来的先回，日志也跟时间线一致
  items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  // 问配额要花一次请求，有活干才问
  const unseen = items.filter((m) => m.id && !seen.has(m.id));
  let budget = unseen.length ? await replyBudgetLeft() : null;

  let replied = 0;
  let skipped = 0;
  let fresh = 0;

  for (const m of items) {
    if (!m.id || seen.has(m.id)) continue;
    fresh += 1;

    const reason = skipReason(m, state, self, nowSec, budget);
    if (reason) {
      log.debug(`mentions: skip ${m.id} by @${m.username} —— ${reason}`);
      seen.add(m.id);
      skipped += 1;
      continue;
    }

    try {
      const id = await publish({
        media_type: 'TEXT',
        text: clockText(threads.brand),
        reply_to_id: m.id,
      });
      log.info(`mentions: replied to @${m.username} ${m.permalink || m.id} (id=${id ?? '-'})`);
      seen.add(m.id);
      markReplied(m.id);
      delete state.failed[m.id];
      state.users[String(m.username || '')] = nowSec;
      state.dayCount += 1;
      spendReplyBudget();
      if (budget !== null) budget -= 1;
      replied += 1;
    } catch (err) {
      // 不重试：下一轮 poll 就是重试，窗口还盖得住。失败的不进 seen，攒够 MAX_FAILS 才放弃
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
  // 无论这轮有没有货，窗口都往前推
  state.since = nowSec - OVERLAP_SEC;
  writeState(prune(state, batchIds, nowSec));

  const line = `mentions: ${items.length} in window, ${fresh} new, ${replied} replied, ${skipped} skipped`;
  if (replied || skipped) log.info(line);
  else log.debug(line);
}

// 启动自检：少了 scope 的话 /mentions 每次都回一个看不出原因的 500。
// 这是重新生成 token 才能修的，与其每轮撞墙，不如开跑前说清楚然后停掉
let preflighted = false;
async function preflight() {
  if (preflighted) return true;

  const scopes = await tokenScopes();
  if (!scopes.includes(REQUIRED_SCOPE)) {
    log.error(`mentions watcher 停了：token 里没有 ${REQUIRED_SCOPE}，/mentions 调不动。`);
    log.error(`  这个 token 现有权限：${scopes.join(', ') || '（一个都没查到）'}`);
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
let failStreak = 0;
let nextAttemptAt = 0;

async function tick() {
  // 上一轮没跑完就跳过：两轮叠在一起会各读一份 state 再写回，后写的覆盖先写的
  if (running) {
    log.debug('mentions: previous tick still running, skip');
    return;
  }
  // ready 由 index.js 维护，这里只跟随不自己 init —— 两边同时 refresh 会把彼此的 token 作废
  if (!threads.ready) {
    log.debug('mentions: threads not ready, skip');
    return;
  }

  if (Date.now() < nextAttemptAt) return;

  running = true;
  try {
    // 自检不过就别再跑了
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
    // 一轮失败不值得惊动进程，下一轮就是重试；连着失败就拉长间隔，别刷屏
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

  // 故意不 unref：万一 node-schedule 那边出意外，这个定时器 ref 住进程是好事
  timer = setInterval(tick, pollSec * 1000);
  tick();   // 启动就先拉一轮，不用干等第一个 pollSec
  return timer;
}
