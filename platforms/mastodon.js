// 长毛象：标准 REST API，token 不过期（scope 只要 write:statuses），adapter 无状态。
import config from '../config.js';
import { log } from '../lib/log.js';

const cfg = config.mastodon || {};
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
  log.debug(`mastodon ${method} ${path}`);
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }

  log.debug(`mastodon ${method} ${path} -> ${res.status} (${Date.now() - started}ms)`);

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.statusCode = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export default {
  name: 'mastodon',
  brand: '长毛象',
  enabled: Boolean(cfg.enabled),

  async init() {
    const me = await api('/api/v1/accounts/verify_credentials');
    log.info(`mastodon authenticated as @${me.username}@${new URL(base).host} (bot=${me.bot})`);
    if (!me.bot) log.warn('mastodon account is not flagged as a bot — 请在账号设置里勾选「这是一个机器人账户」');
  },

  async post(text, ctx) {
    const body = await api('/api/v1/statuses', {
      method: 'POST',
      // 服务端缓存 1 小时，同一整点内重试/重启都不会重复发嘟（key 见 lib/text.js）
      headers: { 'Idempotency-Key': ctx.idempotencyKey },
      form: { status: text, visibility: 'public', language: 'zh' },
    });
    return (body && (body.url || body.id));
  },
};
