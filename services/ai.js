/**
 * AI reply service. To add a provider, write a module like gemini.js:
 *   { name, enabled, ask({ system, user, generationConfig }) -> string }
 * and add it to PROVIDERS. Array order is the fallback order.
 */
import { log, describeError } from '../lib/log.js';
import { isRetryable } from '../lib/retry.js';
import gemini from './gemini.js';

const PROVIDERS = [gemini];

// Non-retryable errors (bad key, unknown model) won't fix themselves, and the caller polls every
// minute. Mute the provider so the log isn't flooded; try again when the mute ends
const MUTE_MS = 10 * 60 * 1000;
const mutedUntil = new Map();

export function aiProviders() {
  return PROVIDERS.filter((p) => p.enabled).map((p) => p.name);
}

// Ask in order; use the first text. No retry here: the caller has its own fail count and backoff,
// and two layers would try one comment a dozen times
export async function ask(req) {
  const usable = PROVIDERS.filter((p) => p.enabled);
  if (!usable.length) {
    const err = new Error('No AI provider available (check enabled and apiKey in config.ai.gemini)');
    err.noProvider = true;
    throw err;
  }

  let lastErr;
  for (const p of usable) {
    const muted = mutedUntil.get(p.name) || 0;
    if (Date.now() < muted) {
      log.debug(`ai: ${p.name} muted, retry in ${Math.round((muted - Date.now()) / 1000)}s`);
      continue;
    }

    const started = Date.now();
    try {
      const text = await p.ask(req);
      mutedUntil.delete(p.name);
      log.debug(`ai: ${p.name} OK (${Date.now() - started}ms, ${text.length} chars)`);
      return { text, provider: p.name };
    } catch (err) {
      lastErr = err;
      if (isRetryable(err)) {
        // 429 (free-tier rate limit) and 5xx usually pass by the next round; don't mute
        log.warn(`ai: ${p.name} failed (retryable): ${describeError(err)}`);
      } else if (err.perRequest) {
        // A problem with this one request (blocked by safety, no text); the next comment may be fine,
        // so don't mute. Log err.message, not describeError: err.body is the raw Gemini response and
        // would print as {}. perRequest messages already include the provider name (see gemini.js)
        log.warn(`ai: ${err.message}`);
      } else {
        mutedUntil.set(p.name, Date.now() + MUTE_MS);
        log.error(`ai: ${p.name} failed, muted for ${MUTE_MS / 60000} minutes: ${describeError(err)}`);
      }
    }
  }

  // All muted: lastErr is undefined (no request was sent). That isn't this comment's fault;
  // callers use noProvider to tell the difference
  if (lastErr) throw lastErr;
  const err = new Error('All AI providers are muted');
  err.noProvider = true;
  throw err;
}
