/**
 * 长毛象（Mastodon）：标准 REST API，token 从「偏好设置 → 开发 → 新建应用」直接拿，
 * scope 只需要 write:statuses，token 不过期，所以这个 adapter 是无状态的。
 */
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
    // 实例规则要求机器人账户如实标注，没勾上的话提醒一下
    if (!me.bot) log.warn('mastodon account is not flagged as a bot — 请在账号设置里勾选「这是一个机器人账户」');
  },

  async post(text, ctx) {
    const body = await api('/api/v1/statuses', {
      method: 'POST',
      // 服务端保存 1 小时，同一整点内重试/重启都不会重复发嘟。
      // key 由 index.js 按「整点报时 / 启动播报」分别生成，两者不能撞（撞了后发的会被静默去重）
      headers: { 'Idempotency-Key': ctx.idempotencyKey },
      form: { status: text, visibility: 'public', language: 'zh' },
    });
    return (body && (body.url || body.id));
  },
};
