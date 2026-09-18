/**
 * 大笨钟 —— 整点报时，同时发豆瓣 / Threads / 长毛象
 * @authors RalfZ (ralfz.zhang@gmail.com)
 */
import ns from 'node-schedule';

import { log, describeError } from './lib/log.js';
import { beat } from './lib/heartbeat.js';
import { sleep, isRetryable } from './lib/retry.js';
import { getText, idempotencyKey, now } from './lib/text.js';
import douban from './platforms/douban.js';
import threads from './platforms/threads/index.js';
import mastodon from './platforms/mastodon.js';

const platforms = [douban, threads, mastodon].filter((p) => p.enabled);

const once = process.argv.includes('--once');

// POST_ON_STARTUP：逗号分隔的平台名或 all，空 / 0 / false 则不发。
// 用途是修完某个平台重启后只让它发一条，确认发布链路真的通了
function startupTargets() {
  const raw = (process.env.POST_ON_STARTUP || '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'false') return [];
  if (raw === '1' || raw === 'all') return platforms;

  const want = raw.split(',').map((n) => n.trim()).filter(Boolean);
  const unknown = want.filter((n) => !platforms.some((p) => p.name === n));
  if (unknown.length) {
    log.warn(`POST_ON_STARTUP 里的 ${unknown.join(', ')} 不是已启用的平台，忽略`
      + `（可选：${platforms.map((p) => p.name).join(' / ')} / all）`);
  }
  return platforms.filter((p) => want.includes(p.name));
}

const MAX_ATTEMPTS = 3;

// 单个平台的一次投递，失败只影响自己。5xx / 限流 / 网络抖动一次就放弃等于白丢一个整点，
// 所以重试统一在这里做，adapter 只管把错误如实抛出来
async function deliver(p, text, ctx) {
  const started = Date.now();
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (!p.ready) {
        await p.init();
        p.ready = true;
      }
      log.debug(`${p.name} <- ${text}`);
      const id = await p.post(text, ctx);
      log.info(`${p.name} OK (id=${id ?? '-'}, ${Date.now() - started}ms)`);
      return;
    } catch (err) {
      lastErr = err;
      // 不动 p.ready：能进重试的都是 5xx / 限流 / 网络抖动，重登没意义；
      // 真要重登的（token 失效）是 4xx，会直接落到下面
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) break;
      log.warn(`${p.name} attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying: ${describeError(err)}`);
      await sleep(2000 * attempt);
    }
  }

  // 标记下轮重新 init —— token 失效这类问题靠重登自愈
  p.ready = false;
  log.error(`${p.name} FAILED (${Date.now() - started}ms): ${describeError(lastErr)}`);
  throw lastErr;
}

// 各平台共用同一个 at，保证报的进度百分比逐字一致
async function postRound(makeText, { at = now(), targets = platforms, kind = 'hourly' } = {}) {
  const ctx = { at, kind, idempotencyKey: idempotencyKey(kind, at) };
  const results = await Promise.allSettled(
    targets.map((p) => deliver(p, makeText(p, at), ctx)),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  log.info(`round done: ${ok}/${targets.length} succeeded`);
  return ok;
}

async function postHourly() {
  const at = now();
  log.info(`posting for ${at.format('YYYY-MM-DD HH:00')}`);
  await postRound((p, t) => getText(p.brand, t), { at });
}

// 进程级异常也要留下日志，方便容器重启后回溯
process.on('unhandledRejection', (reason) => {
  log.error(`unhandledRejection: ${describeError(reason instanceof Error ? reason : { message: String(reason) })}`);
});
process.on('uncaughtException', (err) => {
  log.error(`uncaughtException: ${describeError(err)}`);
  process.exit(1);
});

log.info(`大笨钟 starting (node ${process.version}, log level ${process.env.LOG_LEVEL || 'info'})`);

if (!platforms.length) {
  log.error('没有启用任何平台，检查 config.js 里各平台的 enabled');
  process.exit(1);
}
log.info(`platforms: ${platforms.map((p) => p.name).join(', ')}`);
beat();

// 启动时先登一遍让问题当场暴露，但登不上不能退出 ——
// 配合 restart: unless-stopped 就是无限重启，下个整点自会重试
await Promise.allSettled(platforms.map(async (p) => {
  try {
    await p.init();
    p.ready = true;
  } catch (err) {
    p.ready = false;
    log.error(`${p.name} init failed (will retry hourly): ${describeError(err)}`);
  }
}));

if (once) {
  const ok = await postRound((p, t) => getText(p.brand, t));
  process.exit(ok === platforms.length ? 0 : 1);
}

const startup = startupTargets();
if (startup.length) {
  log.info(`startup notice -> ${startup.map((p) => p.name).join(', ')}`);
  await postRound(() => '尝试启动中……', { targets: startup, kind: 'boot' });
} else {
  log.info('startup notice skipped (POST_ON_STARTUP=douban 可让指定平台发一条确认发布链路)');
}

ns.scheduleJob('0 * * * *', postHourly);

// screen detach 无任务 1 小时后不执行 schedule，每十分钟唤醒一次；顺便刷新心跳
ns.scheduleJob('30 */10 * * * *', () => {
  log.debug('wakeup tick');
  beat();
});

// Threads 长效 token 每天续一次（内部有「满 24 小时才续」的判断）
if (threads.enabled) {
  ns.scheduleJob('0 4 * * *', async () => {
    try { await threads.maybeRefresh(); }
    catch (err) { log.error(`threads token refresh failed: ${describeError(err)}`); }
  });
}

// 两个可选功能：被 at 自动回复、评论区自动回复。不要了就把对应的两行删掉，
// 别处不用动（quota.js / replied.js 两者共用，别跟着删）。
// import 放这儿是为了删的时候不用翻两个地方 —— ESM 的 import 会提升，跟放开头等价。
import { startMentionWatcher } from './platforms/threads/mentions.js';
startMentionWatcher();

import { startReplyWatcher } from './platforms/threads/reply.js';
startReplyWatcher();

