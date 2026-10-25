/**
 * Google Gemini. Only sends { system, user } and returns the text.
 * Persona, time questions and length limits live in platforms/threads/reply.js.
 * Free-tier rate limits return 429, which is retryable; the watcher tries again next round.
 */
import config from '../config.js';
import { log } from '../lib/log.js';

const cfg = (config.ai || {}).gemini || {};

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Override with config.ai.gemini.model. A wrong name gets a 404
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

// The default thresholds block any request with swear words, so we couldn't reply.
// BLOCK_ONLY_HIGH blocks only the really bad ones
const SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

// Don't make maxOutputTokens small: newer models spend thinking tokens from it too,
// and a small value gives finishReason=MAX_TOKENS with empty text
const DEFAULTS = { temperature: 1, maxOutputTokens: 800 };

export default {
  name: 'gemini',
  enabled: Boolean(cfg.enabled && cfg.apiKey),

  async ask({ system, user, generationConfig } = {}) {
    if (!cfg.apiKey) {
      throw new Error('config.ai.gemini.apiKey is empty. Get a free key at https://aistudio.google.com/apikey');
    }

    const model = cfg.model || DEFAULT_MODEL;
    const body = {
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { ...DEFAULTS, ...(cfg.generationConfig || {}), ...(generationConfig || {}) },
      safetySettings: SAFETY,
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const started = Date.now();
    log.debug(`gemini POST ${model}:generateContent`);
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      // Key in a header, not the query string: proxies log query strings
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 20000),
    });

    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    log.debug(`gemini POST ${model}:generateContent -> ${res.status} (${Date.now() - started}ms)`);

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.statusCode = res.status;
      err.body = parsed;
      throw err;
    }

    const cand = parsed?.candidates?.[0];
    const out = (cand?.content?.parts || []).map((p) => p.text).filter(Boolean).join('').trim();
    if (out) return out;

    // HTTP 200 but no text. Turn Google's hints into a readable reason
    const blocked = parsed?.promptFeedback?.blockReason;
    const why = blocked ? `the input was blocked by safety filters (blockReason=${blocked})`
      : cand?.finishReason === 'MAX_TOKENS' ? 'maxOutputTokens is too small, thinking used it all (raise it or turn off thinking in generationConfig)'
        : cand?.finishReason ? `finishReason=${cand.finishReason}`
          : 'no candidates in the response';
    const err = new Error(`gemini returned no text: ${why}`);
    err.body = parsed;
    // Per request: don't let services/ai.js mute the provider. One blocked comment
    // shouldn't stop replies to everyone for ten minutes
    err.perRequest = true;
    throw err;
  },
};
