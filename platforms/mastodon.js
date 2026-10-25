// Mastodon: standard REST API. The token never expires (scope write:statuses only), so no state.
// One account per language, maybe on different instances. Top-level config.mastodon is the main
// Chinese account, named mastodon; config.mastodon.accounts.en etc. are named mastodon-en.
import config from '../config.js';
import { getLocale } from '../lib/locales/index.js';
import { log } from '../lib/log.js';

// key is the language and the name suffix; the main Chinese account has key ''
function createAccount(key, cfg) {
  const name = key ? `mastodon-${key}` : 'mastodon';
  const locale = getLocale(key || 'zh');
  const base = (cfg.instance || '').replace(/\/$/, '');

  async function api(path, { method = 'GET', form, headers = {} } = {}) {
    const init = {
      method,
      headers: { Authorization: `Bearer ${cfg.accessToken}`, ...headers },
      signal: AbortSignal.timeout(15000),
    };
    if (form) {
      init.body = new URLSearchParams(form).toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const started = Date.now();
    log.debug(`${name} ${method} ${path}`);
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }

    log.debug(`${name} ${method} ${path} -> ${res.status} (${Date.now() - started}ms)`);

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.statusCode = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  return {
    name,
    locale,
    // The Chinese account is 长毛象大笨钟; other languages use locale.brand (Big Ben)
    brand: locale.brand || '长毛象',
    enabled: Boolean(cfg.enabled),

    async init() {
      const me = await api('/api/v1/accounts/verify_credentials');
      log.info(`${name} authenticated as @${me.username}@${new URL(base).host} (bot=${me.bot})`);
      if (!me.bot) log.warn(`${name} account is not flagged as a bot. Turn on the bot (automated account) flag in account settings`);
    },

    async post(text, ctx) {
      const body = await api('/api/v1/statuses', {
        method: 'POST',
        // The server keeps the key for 1 hour, so retries and restarts within the hour post once
        // (see lib/text.js). Keys are per account, so accounts sharing a key don't block each other
        headers: { 'Idempotency-Key': ctx.idempotencyKey },
        form: { status: text, visibility: 'public', language: locale.code },
      });
      return (body && (body.url || body.id));
    },
  };
}

const root = config.mastodon || {};

// accounts.en → mastodon-en
export const accounts = [
  createAccount('', root),
  ...Object.entries(root.accounts || {}).map(([key, cfg]) => createAccount(key, cfg)),
];
