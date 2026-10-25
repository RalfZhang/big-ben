/**
 * Shared reply quota gate. Both watchers use one pool (1000 API replies per rolling 24h);
 * separate counts could add up to more, so ask the server for real usage. This also survives
 * restarts, matches the rolling window, and counts manual replies from the app.
 *
 * Hourly posts don't use this pool: posts have their own 250 / 24h.
 */
import config from '../../config.js';
import { log, describeError } from '../../lib/log.js';
import { main as threads } from './index.js';

const cfg = config.threads || {};

// Used when reply_config is missing; the number from Meta's docs
const FALLBACK_TOTAL = 1000;

const headroom = Math.max(0, Number(cfg.replyQuotaHeadroom ?? 100));

// Cache for a minute instead of asking before every reply; replies sent meanwhile are counted in `spent`
const CACHE_MS = 60 * 1000;

let cache = { at: 0, left: null };
let spent = 0;
let warned = false;

// Replies left. null = unknown, and callers fall back to their dailyCap.
// null rather than 0: a flaky endpoint shouldn't stop the whole feature
export async function replyBudgetLeft() {
  if (cache.left !== null && Date.now() - cache.at < CACHE_MS) {
    return Math.max(0, cache.left - spent);
  }

  try {
    const body = await threads.graph(`/${threads.owner}/threads_publishing_limit`, {
      form: { fields: 'reply_quota_usage,reply_config' },
    });
    // The edge returns { data: [ {...} ] }, but accept a bare object too
    const row = (Array.isArray(body?.data) ? body.data[0] : body) || {};
    const total = Number(row.reply_config?.quota_total) || FALLBACK_TOTAL;
    const used = Number(row.reply_quota_usage) || 0;

    cache = { at: Date.now(), left: Math.max(0, total - headroom - used) };
    spent = 0;
    warned = false;
    log.debug(`threads reply quota: used ${used}/${total}, reserved ${headroom}, ${cache.left} left`);
    return cache.left;
  } catch (err) {
    // Warn once per state change, not every minute
    if (!warned) {
      log.warn(`threads_publishing_limit unavailable, falling back to each dailyCap: ${describeError(err)}`);
      warned = true;
    }
    cache = { at: Date.now(), left: null };
    return null;
  }
}

// Call after each reply, so checks during the cache period stay correct
export function spendReplyBudget(n = 1) {
  spent += n;
}
