// 长毛象：标准 REST API，token 不过期（scope 只要 write:statuses），adapter 无状态。
// 可以有多个账号（每种语言一个，实例也可以不同）：config.mastodon 顶层是中文主账号，
// 名字叫 mastodon；config.mastodon.accounts.en 之类是其他语言，名字叫 mastodon-en。
import config from '../config.js';
import { getLocale } from '../lib/locales/index.js';
import { log } from '../lib/log.js';

// key 是语言，也是账号名后缀；中文主账号的 key 是空串
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
    // 中文主账号叫「长毛象大笨钟」，其他语言统一叫 locale.brand（Big Ben）
    brand: locale.brand || '长毛象',
    enabled: Boolean(cfg.enabled),

    async init() {
      const me = await api('/api/v1/accounts/verify_credentials');
      log.info(`${name} authenticated as @${me.username}@${new URL(base).host} (bot=${me.bot})`);
      if (!me.bot) log.warn(`${name} account is not flagged as a bot — 请在账号设置里勾选「这是一个机器人账户」`);
    },

    async post(text, ctx) {
      const body = await api('/api/v1/statuses', {
        method: 'POST',
        // 服务端缓存 1 小时，同一整点内重试/重启都不会重复发嘟（key 见 lib/text.js）。
        // key 在服务端按账号隔离，多个账号用同一个 key 不会互相吞
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
