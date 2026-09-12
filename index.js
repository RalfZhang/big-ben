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

// POST_ON_STARTUP：逗号分隔的平台名（douban / threads / mastodon），或 all；
// 空 / 0 / false 则不发。用途是修完某个平台重启后只让它发一条，确认发布链路真的通了 ——
// 全发的话另外两个平台就是白噪音。
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

// 单个平台的一次投递。失败只影响自己，并标记下轮重新 init。
// 实例 500、限流、网络抖动都是「下一秒就好了」的错，一次就放弃等于白丢一个整点，
// 所以在这里统一退避重试 —— 各平台 adapter 只管把错误如实抛出来。
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
      // 这里不动 p.ready：能进重试的都是 5xx / 限流 / 网络抖动，重登一遍没有意义。
      // 真正需要重登的错（token 失效）是 4xx，不可重试，会直接落到下面
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) break;
      log.warn(`${p.name} attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying: ${describeError(err)}`);
      await sleep(2000 * attempt);
    }
  }

  // 彻底失败，标记下轮重新 init —— token 失效这类问题靠重登自愈
  p.ready = false;
  log.error(`${p.name} FAILED (${Date.now() - started}ms): ${describeError(lastErr)}`);
  throw lastErr;
}

// makeText 收到同一个 at，保证各平台报的进度百分比逐字一致
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

// 兜底：进程级异常也要留下日志，方便容器重启后回溯
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

// 启动时先把各平台登上，问题当场暴露；但登不上不能拖垮进程 ——
// 否则配合 restart: unless-stopped 就是无限重启，下个整点自会重试。
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

// screen detach 无任务 1 小时后不执行 schedule，添加每十分钟唤醒；顺便刷新心跳
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

// ---- 被 at 自动回复当前时间（可选功能）----------------------------------
// 整份实现在 ./platforms/threads/mentions.js。不要了，把下面这两行连同本段注释一起删掉即可，
// 别处不用动。import 写在这里而不是文件顶上，就是为了删的时候不用翻两个地方 ——
// ESM 的 import 声明在模块顶层的任何位置都会被提升，放这儿和放开头等价。
import { startMentionWatcher } from './platforms/threads/mentions.js';
startMentionWatcher();
// -------------------------------------------------------------------------

