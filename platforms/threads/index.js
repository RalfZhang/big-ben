/**
 * Threads：官方 Graph API，两步发布（先建 container，再 publish）。
 *
 * 唯一有状态的平台：长效 token 60 天过期，必须落盘，否则重启就丢掉已续期的那份。
 * 初始 token 从 config.threads.accessToken 播种进 data/threads-token.json，
 * 之后以文件为准，进程每天自己续期。拿 token 的几条路见 deploy.md。
 */
import fs from 'node:fs';
import path from 'node:path';

import config from '../../config.js';
import { log, describeError } from '../../lib/log.js';
import { sleep } from '../../lib/retry.js';

const cfg = config.threads || {};
const GRAPH = 'https://graph.threads.net/v1.0';
const REFRESH_URL = 'https://graph.threads.net/refresh_access_token';

export const owner = cfg.userId || 'me';

export const TOKEN_FILE = process.env.THREADS_TOKEN_FILE
  || new URL('../../data/threads-token.json', import.meta.url).pathname;

const DAY = 24 * 60 * 60 * 1000;

let token = null;   // { accessToken, expiresAt, refreshedAt }

function readToken() {
  const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
  const t = JSON.parse(raw);
  if (!t.accessToken) throw new Error(`${TOKEN_FILE} 里没有 accessToken`);
  return t;
}

// 首次启动：文件还不存在，拿 config 里的 token 播种。之后以文件为准
function seedToken() {
  if (!cfg.accessToken) {
    throw new Error('config.threads.accessToken 是空的 —— 去 Meta 后台 '
      + 'Use cases → Customize → Settings → User Token Generator 点 Generate Access Token');
  }
  // Token Generator 给的就是 60 天长效 token。refreshedAt 记成现在而不是 0：
  // 不满 24 小时的 token 去续期会被 Meta 直接拒
  const t = {
    accessToken: cfg.accessToken,
    expiresAt: Date.now() + 60 * DAY,
    refreshedAt: Date.now(),
  };
  writeToken(t);
  log.info(`threads token seeded from config into ${TOKEN_FILE}`);
  return t;
}

function writeToken(t) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${JSON.stringify(t, null, 2)}\n`);
}

// 自己的 username，两个 watcher 靠它认出「这条是自己发的」（自己回自己是死循环）。
// init() 已经查过一次并缓存，这里通常不发请求
let selfName = null;

export async function whoami() {
  if (selfName) return selfName;
  const me = await graph(`/${owner}`, { form: { fields: 'username' } });
  selfName = String(me.username || '').toLowerCase();
  return selfName;
}

export async function graph(path, { method = 'GET', form, base = GRAPH } = {}) {
  const u = new URL(`${base}${path}`);
  const init = { method, signal: AbortSignal.timeout(20000) };

  if (method === 'GET') {
    u.searchParams.set('access_token', token.accessToken);
    for (const [k, v] of Object.entries(form || {})) u.searchParams.set(k, v);
  } else {
    const body = new URLSearchParams(form || {});
    body.set('access_token', token.accessToken);
    init.body = body.toString();
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  }

  const started = Date.now();
  log.debug(`threads ${method} ${u.pathname}`);
  const res = await fetch(u.toString(), init);
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }

  log.debug(`threads ${method} ${u.pathname} -> ${res.status} (${Date.now() - started}ms)`);

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.statusCode = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// Meta 的错误码埋在 { error: { code } } 里，直接读 err.body.code 永远是 undefined
export function errorCode(err) {
  return err?.body?.error?.code ?? err?.body?.code;
}

// 过期是本地就能判定的死局，救法明确，值得单独报出来
function assertNotExpired() {
  if (token.expiresAt && token.expiresAt <= Date.now()) {
    throw new Error(`Threads token 已于 ${new Date(token.expiresAt).toISOString()} 过期。`
      + '救法：跑过 npm run threads:auth 的话就再跑一次（它直接重写 token 文件）；'
      + '否则去 Meta 后台重新 Generate Access Token，填进 config.threads.accessToken，'
      + `再删掉 ${TOKEN_FILE} 让它重新播种。`);
  }
}

// 满 24 小时才允许续期，每次续期重新计 60 天
async function maybeRefresh() {
  if (!token) token = readToken();
  assertNotExpired();

  const age = Date.now() - (token.refreshedAt || 0);
  if (age < DAY) {
    log.debug(`threads token is ${Math.round(age / 3600000)}h old, too young to refresh`);
    return;
  }

  const body = await graph('', { base: REFRESH_URL, form: { grant_type: 'th_refresh_token' } });
  if (!body.access_token) throw body;

  token = {
    accessToken: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 60 * 24 * 3600) * 1000,
    refreshedAt: Date.now(),
  };
  writeToken(token);
  log.info(`threads token refreshed, expires ${new Date(token.expiresAt).toISOString().slice(0, 10)}`);
}

// container 不是建完就能发的：实测马上 publish 会吃 HTTP 400 code 24，要等几秒。
// code 24 无论出现在查状态还是 publish，都是「还没就绪」；别的错才是真查不到，
// 那就直接往下走，让 publish 自己去撞
async function waitReady(id, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  let state;

  for (;;) {
    let st = null;
    try {
      st = await graph(`/${id}`, { form: { fields: 'status,error_message' } });
    } catch (err) {
      // 头几秒 container 连查都查不到，GET 自己就吃 code 24，等同 IN_PROGRESS
      if (errorCode(err) !== 24) {
        log.debug(`threads container ${id} status query failed: ${describeError(err)}`);
        return;
      }
      state = 'not-visible-yet';
    }

    if (st) {
      if (st.status === 'FINISHED') return;
      // 这两个状态自己好不了，重建也是同样的内容，直接抛出来
      if (st.status === 'ERROR' || st.status === 'EXPIRED') {
        const err = new Error(`threads container ${st.status}`);
        err.body = { error: { code: st.status, message: st.error_message || 'no error_message' } };
        throw err;
      }
      state = st.status;
    }

    if (Date.now() + delay > deadline) {
      log.warn(`threads container ${id} still ${state} after ${timeoutMs}ms, publishing anyway`);
      return;
    }
    log.debug(`threads container ${id} ${state}, waiting ${delay}ms`);
    await sleep(delay);
    delay = Math.min(delay * 2, 4000);
  }
}

// 建 container → 等就绪 → publish。报时和两个自动回复走同一条路，
// 差别只在 form 里多不多一个 reply_to_id
export async function publish(form) {
  const container = await graph(`/${owner}/threads`, { method: 'POST', form });
  if (!container.id) throw container;

  await waitReady(container.id);

  // 轮询之后一般一次就过，这个循环只兜底 code 24。别的错一律抛给 index.js 的统一重试，
  // 免得两层各 3 次叠成 9 次请求
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const published = await graph(`/${owner}/threads_publish`, {
        method: 'POST',
        form: { creation_id: container.id },
      });
      return published && published.id;
    } catch (err) {
      lastErr = err;
      if (errorCode(err) !== 24) break;
      log.warn(`threads publish attempt ${attempt}/3 failed (container 未就绪): ${describeError(err)}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }

  // 放弃之前问一下状态，失败原因通常写在 error_message 里。
  // FINISHED 且没有 error_message 说明锅不在 container 上，不值得占着 WARN
  try {
    const st = await graph(`/${container.id}`, { form: { fields: 'status,error_message' } });
    const line = `threads container ${container.id} status=${st.status} ${st.error_message || ''}`.trim();
    if (st.status === 'FINISHED' && !st.error_message) log.debug(line);
    else log.warn(line);
  } catch { /* 诊断用，问不到就算了 */ }
  throw lastErr;
}

// token 里少一个 scope 时，Threads 只回 HTTP 500 code 1 "An unknown error occurred"，
// 不告诉你缺哪个 —— 只能主动问 debug_token。两个 watcher 的启动自检用
export async function tokenScopes() {
  const body = await graph('/debug_token', {
    base: 'https://graph.threads.net',
    form: { input_token: token.accessToken },
  });
  return body?.data?.scopes || [];
}

export default {
  name: 'threads',
  brand: '脆脆',   // 跟账号名「脆脆大笨钟」一致
  enabled: Boolean(cfg.enabled),
  maybeRefresh,

  async init() {
    if (fs.existsSync(TOKEN_FILE)) token = readToken();
    else token = seedToken();

    assertNotExpired();

    // 续期失败不代表这个 token 不能用（比如刚播种的还不满 24 小时），
    // 说了算的是下面那次 /me
    try {
      await maybeRefresh();
    } catch (err) {
      log.warn(`threads token refresh skipped: ${describeError(err)}`);
    }

    const me = await graph(`/${owner}`, { form: { fields: 'id,username' } });
    selfName = String(me.username || '').toLowerCase();
    log.info(`threads authenticated as @${me.username} (id=${me.id}), token expires `
      + `${new Date(token.expiresAt).toISOString().slice(0, 10)}`);
  },

  post(text) {
    return publish({ media_type: 'TEXT', text });
  },
};
