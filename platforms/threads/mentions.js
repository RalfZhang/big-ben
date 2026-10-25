/**
 * Optional: reply with the current time when someone @mentions us. The whole feature is this file
 * (to remove it, delete this file and its two lines in index.js).
 *
 * vs reply.js: this reads /mentions; reply.js reads /conversation on our own posts. A comment under
 * our post that also @mentions us shows up in both: replied.js prevents double replies, and the
 * quota is shared (quota.js).
 *
 * Polling, not webhooks: the process has no public endpoint, and the delay is at most pollSeconds.
 *
 * Needs threads_manage_mentions. Without Advanced Access only mentions from Threads testers
 * show up, so 0 in the log is normal (see doc/deploy.md).
 */
import fs from 'node:fs';
import path from 'node:path';

import config from '../../config.js';
import { log, describeError } from '../../lib/log.js';
import { now } from '../../lib/text.js';
// Main Chinese account only. Other accounts would need a watcher per account
import { main as threads } from './index.js';
import { replyBudgetLeft, spendReplyBudget } from './quota.js';
import { hasReplied, markReplied } from './replied.js';

const cfg = (config.threads || {}).mentions || {};

export const STATE_FILE = process.env.THREADS_MENTIONS_FILE
  || new URL('../../data/threads-mentions.json', import.meta.url).pathname;

// Look back 5 extra minutes each round: the index lags, and a mention inside the lag
// would be skipped forever. seen removes the duplicates
const OVERLAP_SEC = 300;

// Threads launch time; an earlier since gets a 400
const EPOCH_SEC = 1688540400;

// Fewer fields, fewer 400s. permalink is only for clickable logs
const FIELDS = 'id,text,username,timestamp,permalink';

// seen only needs to cover OVERLAP_SEC
const SEEN_MAX = 200;

// Give up after this many failures in a row (e.g. replies limited to followers never work)
const MAX_FAILS = 3;

// Without it /mentions always fails, with no useful message (see tokenScopes in index.js)
const REQUIRED_SCOPE = 'threads_manage_mentions';

// Max backoff after repeated failures. 15s polls on an unfixable error would log 5760 WARNs a day
const MAX_BACKOFF_SEC = 600;

const pollSec = Math.max(15, Number(cfg.pollSeconds) || 60);
const maxAgeSec = Math.max(60, (Number(cfg.maxAgeMinutes) || 30) * 60);
const cooldownSec = Math.max(0, Number(cfg.userCooldownSeconds ?? 120));
// This feature's own daily cap; the hard limit is in ./quota.js
const dailyCap = Math.max(1, Number(cfg.dailyCap) || 200);

function emptyState() {
  return { since: 0, seen: [], failed: {}, users: {}, day: '', dayCount: 0 };
}

function readState() {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch (err) {
    // If broken, start fresh: missing a few replies beats failing every round
    if (err.code !== 'ENOENT') log.warn(`${STATE_FILE} unreadable, starting fresh: ${err.message}`);
    return emptyState();
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// Every reason to skip is here, so the log shows which rule applied. null = reply
function skipReason(m, state, self, nowSec, budget) {
  const username = String(m.username || '');
  if (username.toLowerCase() === self) return 'own post';

  if (hasReplied(m.id)) return 'already replied elsewhere (shared record)';

  const ts = Date.parse(m.timestamp);
  if (!Number.isFinite(ts)) return `bad timestamp (${m.timestamp})`;

  // After a day offline, telling the time to dozens of old mentions is spam and wastes quota
  const age = nowSec - Math.floor(ts / 1000);
  if (age > maxAgeSec) return `too old (${Math.round(age / 60)} min ago)`;

  if (state.dayCount >= dailyCap) return `daily cap reached (${state.dayCount} today)`;
  if (budget !== null && budget <= 0) return '24h reply quota used up (incl. headroom)';

  const last = state.users[username] || 0;
  if (nowSec - last < cooldownSec) return `@${username} in ${cooldownSec}s cooldown`;

  return null;
}

// Keep state small. Drop failed ids not in this batch: the window has moved past them
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

  // Daily cap per Beijing calendar day
  const today = at.format('YYYY-MM-DD');
  if (state.day !== today) {
    state.day = today;
    state.dayCount = 0;
  }

  // First run with no state: start from "just now". The time is no answer to an hours-old mention
  const since = Math.max(EPOCH_SEC, state.since || (nowSec - OVERLAP_SEC));

  const body = await threads.graph(`/${threads.owner}/mentions`, {
    form: { fields: FIELDS, since: String(since) },
  });
  const items = Array.isArray(body.data) ? body.data : [];

  const self = await threads.whoami();
  const seen = new Set(state.seen);
  const batchIds = new Set(items.map((m) => m.id));

  // Oldest first: reply in order, and logs follow the timeline
  items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  // The quota check costs a request; only ask when there is work
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
      log.debug(`mentions: skip ${m.id} by @${m.username}: ${reason}`);
      seen.add(m.id);
      skipped += 1;
      continue;
    }

    try {
      const id = await threads.publish({
        media_type: 'TEXT',
        text: threads.locale.clock(threads.brand),
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
      // No retry: the next poll is the retry, and the window still covers it.
      // Failed ones stay out of seen until MAX_FAILS
      const n = (state.failed[m.id] || 0) + 1;
      state.failed[m.id] = n;
      log.warn(`mentions: reply to ${m.id} failed ${n}/${MAX_FAILS}: ${describeError(err)}`);
      if (n >= MAX_FAILS) {
        log.error(`mentions: giving up on ${m.id} (@${m.username}) after ${MAX_FAILS} failures`);
        seen.add(m.id);
        delete state.failed[m.id];
      }
    }
  }

  state.seen = [...seen];
  // Move the window forward even if nothing came in
  state.since = nowSec - OVERLAP_SEC;
  writeState(prune(state, batchIds, nowSec));

  const line = `mentions: ${items.length} in window, ${fresh} new, ${replied} replied, ${skipped} skipped`;
  if (replied || skipped) log.info(line);
  else log.debug(line);
}

// Startup check: without the scope, /mentions returns an unexplained 500 every time.
// Only a new token fixes that, so say so clearly and stop instead of failing every round
let preflighted = false;
async function preflight() {
  if (preflighted) return true;

  const scopes = await threads.tokenScopes();
  if (!scopes.includes(REQUIRED_SCOPE)) {
    log.error(`mentions watcher stopped: token lacks ${REQUIRED_SCOPE}, so /mentions can't be called.`);
    log.error(`  Scopes on this token: ${scopes.join(', ') || '(none found)'}`);
    log.error('  Note: the Generate Access Token button in the dashboard cannot grant this scope. '
      + 'It always grants a fixed set (basic / content_publish / manage_replies / read_replies / manage_insights).');
    log.error('  Fix: run npm run threads:auth on the host to authorize via OAuth. '
      + 'It writes a token with all scopes to data/threads-token.json. Then restart. See doc/deploy.md.');
    return false;
  }

  preflighted = true;
  log.info(`mentions: token scopes OK (${scopes.join(', ')})`);
  return true;
}

let running = false;
let timer = null;
let failStreak = 0;
let nextAttemptAt = 0;

async function tick() {
  // Skip if the last tick is still running: overlapping ticks would overwrite each other's state
  if (running) {
    log.debug('mentions: previous tick still running, skip');
    return;
  }
  // index.js owns ready; only follow it. Calling init here too could refresh twice and void each other's token
  if (!threads.ready) {
    log.debug('mentions: threads not ready, skip');
    return;
  }

  if (Date.now() < nextAttemptAt) return;

  running = true;
  try {
    // Stop for good if the check fails
    if (!await preflight()) {
      clearInterval(timer);
      timer = null;
      return;
    }
    await poll();
    if (failStreak) {
      log.info(`mentions: recovered after ${failStreak} failures in a row`);
      failStreak = 0;
    }
  } catch (err) {
    // The next round retries. Back off on repeated failures to avoid log spam
    failStreak += 1;
    const backoff = Math.min(pollSec * 2 ** failStreak, MAX_BACKOFF_SEC);
    nextAttemptAt = Date.now() + backoff * 1000;
    log.warn(`mentions poll failed (#${failStreak}, retry in ${backoff}s): ${describeError(err)}`);
  } finally {
    running = false;
  }
}

export function startMentionWatcher() {
  if (!cfg.enabled) {
    log.info('mentions watcher off (config.threads.mentions.enabled is false)');
    return null;
  }
  if (!threads.enabled) {
    log.warn('mentions watcher needs the threads platform, but config.threads.enabled is false. Not starting');
    return null;
  }

  log.info(`mentions watcher on: poll every ${pollSec}s, reply to mentions from the last ${Math.round(maxAgeSec / 60)} min, `
    + `${cooldownSec}s per-user cooldown, max ${dailyCap} per day`);

  // Not unref'd on purpose: if node-schedule fails, this timer still keeps the process alive
  timer = setInterval(tick, pollSec * 1000);
  tick();   // run once now instead of waiting a full pollSec
  return timer;
}
