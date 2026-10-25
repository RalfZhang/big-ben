/**
 * Big Ben: posts the time every hour to Douban, Threads and Mastodon.
 * @authors RalfZ (ralfz.zhang@gmail.com)
 */
import ns from 'node-schedule';

import { log, describeError } from './lib/log.js';
import { beat } from './lib/heartbeat.js';
import { sleep, isRetryable } from './lib/retry.js';
import { idempotencyKey, now } from './lib/text.js';
import douban from './platforms/douban.js';
import { accounts as threadsAccounts } from './platforms/threads/index.js';
import { accounts as mastodonAccounts } from './platforms/mastodon.js';

// Threads and Mastodon have one account per language; each is its own platform (threads, threads-en, mastodon…)
const platforms = [douban, ...threadsAccounts, ...mastodonAccounts].filter((p) => p.enabled);

const once = process.argv.includes('--once');

// POST_ON_STARTUP: comma-separated platform names, or all. Empty / 0 / false = none.
// Use it after fixing a platform to check that posting works
function startupTargets() {
  const raw = (process.env.POST_ON_STARTUP || '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'false') return [];
  if (raw === '1' || raw === 'all') return platforms;

  const want = raw.split(',').map((n) => n.trim()).filter(Boolean);
  const unknown = want.filter((n) => !platforms.some((p) => p.name === n));
  if (unknown.length) {
    log.warn(`POST_ON_STARTUP: ${unknown.join(', ')} is not an enabled platform, ignored`
      + ` (options: ${platforms.map((p) => p.name).join(' / ')} / all)`);
  }
  return platforms.filter((p) => want.includes(p.name));
}

const MAX_ATTEMPTS = 3;

// One delivery to one platform; a failure affects only that platform.
// All retries happen here, so a short outage doesn't lose the hour. Adapters just throw
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
      // Keep p.ready: retryable errors are 5xx / rate limits / network, where a new login won't help.
      // An invalid token is a 4xx and goes straight to the code below
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) break;
      log.warn(`${p.name} attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying: ${describeError(err)}`);
      await sleep(2000 * attempt);
    }
  }

  // Log in again next round; that fixes problems like an invalid token
  p.ready = false;
  log.error(`${p.name} FAILED (${Date.now() - started}ms): ${describeError(lastErr)}`);
  throw lastErr;
}

// All platforms share one `at`: same-language posts show the same percent,
// and the Mastodon idempotency key is computed once
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
  await postRound((p, t) => p.locale.hourly(p.brand, t), { at });
}

// Log process-level errors too, so they can be traced after a restart
process.on('unhandledRejection', (reason) => {
  log.error(`unhandledRejection: ${describeError(reason instanceof Error ? reason : { message: String(reason) })}`);
});
process.on('uncaughtException', (err) => {
  log.error(`uncaughtException: ${describeError(err)}`);
  process.exit(1);
});

log.info(`Big Ben starting (node ${process.version}, log level ${process.env.LOG_LEVEL || 'info'})`);

if (!platforms.length) {
  log.error('No platform is enabled. Check `enabled` for each platform in config.js');
  process.exit(1);
}
log.info(`platforms: ${platforms.map((p) => p.name).join(', ')}`);
beat();

// Log in at startup so problems show up early. Don't exit on failure: with
// restart: unless-stopped that would be a restart loop. The next hour retries anyway
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
  const ok = await postRound((p, t) => p.locale.hourly(p.brand, t));
  process.exit(ok === platforms.length ? 0 : 1);
}

const startup = startupTargets();
if (startup.length) {
  log.info(`startup notice -> ${startup.map((p) => p.name).join(', ')}`);
  await postRound((p) => p.locale.booting, { targets: startup, kind: 'boot' });
} else {
  log.info('startup notice skipped (POST_ON_STARTUP=douban posts one to check that posting works)');
}

ns.scheduleJob('0 * * * *', postHourly);

// In a detached screen, schedules stop after 1 idle hour, so wake up every 10 minutes.
// Also refresh the heartbeat
ns.scheduleJob('30 */10 * * * *', () => {
  log.debug('wakeup tick');
  beat();
});

// Refresh long-lived tokens daily on platforms with maybeRefresh (each Threads account).
// It skips tokens under 24 hours old. One account failing doesn't affect the others
const refreshable = platforms.filter((p) => p.maybeRefresh);
if (refreshable.length) {
  ns.scheduleJob('0 4 * * *', async () => {
    for (const p of refreshable) {
      try { await p.maybeRefresh(); }
      catch (err) { log.error(`${p.name} token refresh failed: ${describeError(err)}`); }
    }
  });
}

// Two optional features: reply to mentions, reply to comments. To remove one, delete its two lines.
// Nothing else needs to change (quota.js / replied.js are shared; keep them).
// The imports are here so removal touches one place. ESM hoists imports, so this works the same.
import { startMentionWatcher } from './platforms/threads/mentions.js';
startMentionWatcher();

import { startReplyWatcher } from './platforms/threads/reply.js';
startReplyWatcher();

