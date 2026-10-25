/**
 * Threads：官方 Graph API，两步发布（先建 container，再 publish）。
 *
 * 唯一有状态的平台：长效 token 60 天过期，必须落盘，否则重启就丢掉已续期的那份。
 * 初始 token 从 config 里的 accessToken 播种进 data/<账号名>-token.json，
 * 之后以文件为准，进程每天自己续期。拿 token 的几条路见 deploy.md。
 *
 * 可以有多个账号（每种语言一个），共用同一个 Meta app。config.threads 顶层是中文主账号，
 * 名字叫 threads；config.threads.accounts.en 之类是其他语言，名字叫 threads-en。
 */
import fs from 'node:fs';
import path from 'node:path';

import config from '../../config.js';
import { getLocale } from '../../lib/locales/index.js';
import { log, describeError } from '../../lib/log.js';
import { sleep } from '../../lib/retry.js';

const GRAPH = 'https://graph.threads.net/v1.0';
const REFRESH_URL = 'https://graph.threads.net/refresh_access_token';

const DAY = 24 * 60 * 60 * 1000;

// Meta 的错误码埋在 { error: { code } } 里，直接读 err.body.code 永远是 undefined
export function errorCode(err) {
  return err?.body?.error?.code ?? err?.body?.code;
}

// username 比较用：不分大小写，config 里多写个 @ 也认
export function handle(username) {
  return String(username || '').replace(/^@/, '').toLowerCase();
}

// key 是语言（en / es / fr），也是账号名后缀；中文主账号的 key 是空串，名字就叫 threads
function createAccount(key, cfg) {
  const name = key ? `threads-${key}` : 'threads';
  const locale = getLocale(key || 'zh');
  const owner = cfg.userId || 'me';
  // 填了的话 init() 和 threads:auth 都拿它核对 token 是不是这个号的
  const username = handle(cfg.username);

  // 主账号的文件名跟多账号之前一样，升级不用重新授权
  const tokenFile = (!key && process.env.THREADS_TOKEN_FILE)
    || new URL(`../../data/${name}-token.json`, import.meta.url).pathname;

  let token = null;   // { accessToken, expiresAt, refreshedAt }

  function readToken() {
    const raw = fs.readFileSync(tokenFile, 'utf8');
    const t = JSON.parse(raw);
    if (!t.accessToken) throw new Error(`${tokenFile} 里没有 accessToken`);
    return t;
  }

  // 播种、续期、threads:auth 拿到的都是长效 token，到期时间一律从现在起算。
  // refreshedAt 记成现在而不是 0：不满 24 小时的 token 去续期会被 Meta 直接拒
  function saveToken(accessToken, expiresInSec) {
    token = {
      accessToken,
      expiresAt: Date.now() + (Number(expiresInSec) || 60 * 24 * 3600) * 1000,
      refreshedAt: Date.now(),
    };
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, `${JSON.stringify(token, null, 2)}\n`);
  }

  // 首次启动：文件还不存在，拿 config 里的 token 播种。之后以文件为准
  function seedToken() {
    if (!cfg.accessToken) {
      throw new Error(`${name} 的 accessToken 是空的 —— 去 Meta 后台 `
        + 'Use cases → Customize → Settings → User Token Generator 点 Generate Access Token，'
        + '或者跑 npm run threads:auth');
    }
    // Token Generator 给的就是 60 天长效 token
    saveToken(cfg.accessToken);
    log.info(`${name} token seeded from config into ${tokenFile}`);
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
    log.debug(`${name} ${method} ${u.pathname}`);
    const res = await fetch(u.toString(), init);
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }

    log.debug(`${name} ${method} ${u.pathname} -> ${res.status} (${Date.now() - started}ms)`);

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.statusCode = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  // 自己的 username，两个 watcher 靠它认出「这条是自己发的」（自己回自己是死循环）。
  // init() 已经查过一次并缓存，这里通常不发请求
  let selfName = null;

  async function whoami() {
    if (selfName) return selfName;
    const me = await graph(`/${owner}`, { form: { fields: 'username' } });
    selfName = handle(me.username);
    return selfName;
  }

  // 过期是本地就能判定的死局，救法明确，值得单独报出来
  function assertNotExpired() {
    if (token.expiresAt && token.expiresAt <= Date.now()) {
      throw new Error(`${name} token 已于 ${new Date(token.expiresAt).toISOString()} 过期。`
        + `救法：跑过 npm run threads:auth 的话就再跑一次（它直接重写 token 文件）；`
        + '否则去 Meta 后台重新 Generate Access Token，填进 config 里这个账号的 accessToken，'
        + `再删掉 ${tokenFile} 让它重新播种。`);
    }
  }

  // 满 24 小时才允许续期，每次续期重新计 60 天
  async function maybeRefresh() {
    if (!token) token = readToken();
    assertNotExpired();

    const age = Date.now() - (token.refreshedAt || 0);
    if (age < DAY) {
      log.debug(`${name} token is ${Math.round(age / 3600000)}h old, too young to refresh`);
      return;
    }

    const body = await graph('', { base: REFRESH_URL, form: { grant_type: 'th_refresh_token' } });
    if (!body.access_token) throw body;

    saveToken(body.access_token, body.expires_in);
    log.info(`${name} token refreshed, expires ${new Date(token.expiresAt).toISOString().slice(0, 10)}`);
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
          log.debug(`${name} container ${id} status query failed: ${describeError(err)}`);
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
        log.warn(`${name} container ${id} still ${state} after ${timeoutMs}ms, publishing anyway`);
        return;
      }
      log.debug(`${name} container ${id} ${state}, waiting ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }

  // 建 container → 等就绪 → publish。报时和两个自动回复走同一条路，
  // 差别只在 form 里多不多一个 reply_to_id
  async function publish(form) {
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
        log.warn(`${name} publish attempt ${attempt}/3 failed (container 未就绪): ${describeError(err)}`);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }

    // 放弃之前问一下状态，失败原因通常写在 error_message 里。
    // FINISHED 且没有 error_message 说明锅不在 container 上，不值得占着 WARN
    try {
      const st = await graph(`/${container.id}`, { form: { fields: 'status,error_message' } });
      const line = `${name} container ${container.id} status=${st.status} ${st.error_message || ''}`.trim();
      if (st.status === 'FINISHED' && !st.error_message) log.debug(line);
      else log.warn(line);
    } catch { /* 诊断用，问不到就算了 */ }
    throw lastErr;
  }

  // token 里少一个 scope 时，Threads 只回 HTTP 500 code 1 "An unknown error occurred"，
  // 不告诉你缺哪个 —— 只能主动问 debug_token。两个 watcher 的启动自检用
  async function tokenScopes() {
    const body = await graph('/debug_token', {
      base: 'https://graph.threads.net',
      form: { input_token: token.accessToken },
    });
    return body?.data?.scopes || [];
  }

  return {
    key,
    name,
    locale,
    // 中文主账号跟账号名「脆脆大笨钟」一致，其他语言统一叫 locale.brand（Big Ben）
    brand: locale.brand || '脆脆',
    enabled: Boolean(cfg.enabled),
    username,
    owner,
    tokenFile,
    saveToken,
    graph,
    publish,
    whoami,
    tokenScopes,
    maybeRefresh,

    async init() {
      if (fs.existsSync(tokenFile)) token = readToken();
      else seedToken();

      assertNotExpired();

      // 续期失败不代表这个 token 不能用（比如刚播种的还不满 24 小时），
      // 说了算的是下面那次 /me
      try {
        await maybeRefresh();
      } catch (err) {
        log.warn(`${name} token refresh skipped: ${describeError(err)}`);
      }

      const me = await graph(`/${owner}`, { form: { fields: 'id,username' } });
      selfName = handle(me.username);

      // 跑 threads:auth 时浏览器里登错了号，token 就是别的账号的 —— 英文报时会发到中文账号上。
      // 填了 username 就当场拦下，ready 起不来，一条都不发
      if (username && username !== selfName) {
        throw new Error(`${name} 的 token 属于 @${me.username}，不是 config 里写的 @${username}。`
          + `多半是跑 threads:auth 时浏览器登错了号：登对账号重跑一次 npm run threads:auth${key ? ` -- ${key}` : ''}`);
      }

      log.info(`${name} authenticated as @${me.username} (id=${me.id}), token expires `
        + `${new Date(token.expiresAt).toISOString().slice(0, 10)}`);
    },

    post(text) {
      return publish({ media_type: 'TEXT', text });
    },
  };
}

const root = config.threads || {};

// 中文主账号。两个自动回复 watcher 只认它
export const main = createAccount('', root);

// accounts.en → threads-en。appId / appSecret / redirectUri 这些 app 级字段只在顶层填，
// 用到它们的 authorize.js / quota.js 直接读 config.threads
export const accounts = [
  main,
  ...Object.entries(root.accounts || {}).map(([key, cfg]) => createAccount(key, cfg)),
];
