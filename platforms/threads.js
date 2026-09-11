/**
 * Threads：官方 Graph API，两步发布（先建 container，再 publish）。
 *
 * 唯一有状态的平台：长效 token 60 天过期，必须落盘 —— 只放内存的话
 * 进程一重启就丢掉已经续期过的 token，最终会静默过期。
 *
 * 初始 token 直接在 Meta 后台「User Token Generator」点 Generate Access Token 拿到，
 * 填进 config.threads.accessToken 即可（不用走 OAuth 授权码流程）。首次启动会把它
 * 播种进 data/threads-token.json，之后以文件为准，进程每天自己续期。
 */
import fs from 'node:fs';
import path from 'node:path';

import config from '../config.js';
import { log, describeError } from '../lib/log.js';
import { sleep } from '../lib/retry.js';

const cfg = config.threads || {};
const GRAPH = 'https://graph.threads.net/v1.0';
const REFRESH_URL = 'https://graph.threads.net/refresh_access_token';

// 不指定 userId 时用 me，少填一项配置
const owner = cfg.userId || 'me';

export const TOKEN_FILE = process.env.THREADS_TOKEN_FILE
  || new URL('../data/threads-token.json', import.meta.url).pathname;

const DAY = 24 * 60 * 60 * 1000;

let token = null;   // { accessToken, expiresAt, refreshedAt }

function readToken() {
  const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
  const t = JSON.parse(raw);
  if (!t.accessToken) throw new Error(`${TOKEN_FILE} 里没有 accessToken`);
  return t;
}

// 首次启动：state 文件还不存在，就拿 config 里的 token 播种。
// 播种后以文件为准 —— 续期写的是文件，config 里那个会一直是最初那份。
function seedToken() {
  if (!cfg.accessToken) {
    throw new Error('config.threads.accessToken 是空的 —— 去 Meta 后台 '
      + 'Use cases → Customize → Settings → User Token Generator 点 Generate Access Token');
  }
  // Token Generator 给的就是 60 天长效 token。以播种时刻当签发时刻：
  // 刚生成的 token 不满 24 小时，这时候去续期 Meta 会直接拒，所以不能记成 0。
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

async function graph(path, { method = 'GET', form, base = GRAPH } = {}) {
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

// token 满 24 小时才允许续期；每次续期重新计 60 天，
// 所以只要离线不超过 59 天，回来都还能自动救回来。
// 过期是本地就能判定的死局，救法明确，值得单独报出来
function assertNotExpired() {
  if (token.expiresAt && token.expiresAt <= Date.now()) {
    throw new Error(`Threads token 已于 ${new Date(token.expiresAt).toISOString()} 过期。`
      + '去 Meta 后台重新 Generate Access Token，填进 config.threads.accessToken，'
      + `再删掉 ${TOKEN_FILE} 让它重新播种。`);
  }
}

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

// 纯文本 container 并不是立即就绪的：实测建完马上 publish 会吃一个 HTTP 400 code 24
// （查状态是 IN_PROGRESS），要等几秒。先轮询到 FINISHED 再发，省掉那次必然失败的 publish。
// 这只是优化不是前提 —— 状态查不到就直接往下走，让 publish 自己去重试。
async function waitReady(id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;

  for (;;) {
    let st;
    try {
      st = await graph(`/${id}`, { form: { fields: 'status,error_message' } });
    } catch (err) {
      log.debug(`threads container ${id} status query failed: ${describeError(err)}`);
      return;
    }

    if (st.status === 'FINISHED') return;
    // 这两个状态自己好不了，重建 container 也是同样的内容，直接抛出来
    if (st.status === 'ERROR' || st.status === 'EXPIRED') {
      const err = new Error(`threads container ${st.status}`);
      err.body = { error: { code: st.status, message: st.error_message || 'no error_message' } };
      throw err;
    }

    if (Date.now() + delay > deadline) {
      log.warn(`threads container ${id} still ${st.status} after ${timeoutMs}ms, publishing anyway`);
      return;
    }
    log.debug(`threads container ${id} ${st.status}, waiting ${delay}ms`);
    await sleep(delay);
    delay = Math.min(delay * 2, 4000);
  }
}

export default {
  name: 'threads',
  brand: '脆脆',   // 跟账号名「脆脆大笨钟」一致，不用 Threads
  enabled: Boolean(cfg.enabled),
  maybeRefresh,

  async init() {
    if (fs.existsSync(TOKEN_FILE)) token = readToken();
    else token = seedToken();

    assertNotExpired();

    // 续期失败不代表现在这个 token 不能用（比如刚播种的 token 还不满 24 小时），
    // 真正说了算的是下面这次 /me —— 所以这里只警告，不中断。
    try {
      await maybeRefresh();
    } catch (err) {
      log.warn(`threads token refresh skipped: ${describeError(err)}`);
    }

    const me = await graph(`/${owner}`, { form: { fields: 'id,username' } });
    log.info(`threads authenticated as @${me.username} (id=${me.id}), token expires `
      + `${new Date(token.expiresAt).toISOString().slice(0, 10)}`);
  },

  async post(text) {
    // 第一步：建 container
    const container = await graph(`/${owner}/threads`, {
      method: 'POST',
      form: { media_type: 'TEXT', text },
    });
    if (!container.id) throw container;

    // 第二步：等它就绪
    await waitReady(container.id);

    // 第三步：发布。轮询之后一般一次就过，这个循环只兜底「container 还没就绪」(code 24)。
    // 别的错一律抛给 index.js 的统一重试 —— 两层各重试 3 次叠起来就是 9 次请求
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
        if (!err.body || err.body.code !== 24) break;
        log.warn(`threads publish attempt ${attempt}/3 failed (container 未就绪): ${describeError(err)}`);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }

    // 放弃之前问一下 container 状态，失败原因通常写在 error_message 里。
    // FINISHED 且没有 error_message 说明锅不在 container 上，这行就没必要占着 WARN
    try {
      const st = await graph(`/${container.id}`, { form: { fields: 'status,error_message' } });
      const line = `threads container ${container.id} status=${st.status} ${st.error_message || ''}`.trim();
      if (st.status === 'FINISHED' && !st.error_message) log.debug(line);
      else log.warn(line);
    } catch { /* 诊断用，问不到就算了 */ }
    throw lastErr;
  },
};
