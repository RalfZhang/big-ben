/**
 * Threads: official Graph API. Posting has two steps: create a container, then publish it.
 *
 * The only platform with state: long-lived tokens expire after 60 days, so they are saved to disk
 * (or a restart would lose the refreshed one). The first token is seeded from config accessToken
 * into data/<name>-token.json. After that the file wins and the process refreshes it daily.
 * See doc/deploy.md for how to get tokens.
 *
 * One account per language, all sharing one Meta app. Top-level config.threads is the main Chinese
 * account, named threads; config.threads.accounts.en etc. are named threads-en.
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

// Meta puts the code in { error: { code } }, so err.body.code alone is always undefined
export function errorCode(err) {
  return err?.body?.error?.code ?? err?.body?.code;
}

// For comparing usernames: ignore case and a leading @
export function handle(username) {
  return String(username || '').replace(/^@/, '').toLowerCase();
}

// key is the language (en / es / fr) and the name suffix; the main Chinese account has key '' and is named threads
function createAccount(key, cfg) {
  const name = key ? `threads-${key}` : 'threads';
  const locale = getLocale(key || 'zh');
  const owner = cfg.userId || 'me';
  // If set, init() and threads:auth check that the token belongs to this account
  const username = handle(cfg.username);

  // Main account: data/threads-token.json, same as before multi-account support
  const tokenFile = (!key && process.env.THREADS_TOKEN_FILE)
    || new URL(`../../data/${name}-token.json`, import.meta.url).pathname;

  let token = null;   // { accessToken, expiresAt, refreshedAt }

  function readToken() {
    const raw = fs.readFileSync(tokenFile, 'utf8');
    const t = JSON.parse(raw);
    if (!t.accessToken) throw new Error(`${tokenFile} has no accessToken`);
    return t;
  }

  // Seeded, refreshed and threads:auth tokens are all long-lived; expiry counts from now.
  // refreshedAt is now, not 0: Meta rejects refreshing a token under 24 hours old
  function saveToken(accessToken, expiresInSec) {
    token = {
      accessToken,
      expiresAt: Date.now() + (Number(expiresInSec) || 60 * 24 * 3600) * 1000,
      refreshedAt: Date.now(),
    };
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, `${JSON.stringify(token, null, 2)}\n`);
  }

  // First start: no file yet, so seed from config. After that the file wins
  function seedToken() {
    if (!cfg.accessToken) {
      throw new Error(`${name} accessToken is empty. In the Meta dashboard, click `
        + 'Use cases → Customize → Settings → User Token Generator → Generate Access Token, '
        + 'or run npm run threads:auth');
    }
    // Token Generator gives a 60-day long-lived token
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

  // Our own username. Both watchers use it to skip our own posts (replying to ourselves would loop).
  // init() already cached it, so this rarely sends a request
  let selfName = null;

  async function whoami() {
    if (selfName) return selfName;
    const me = await graph(`/${owner}`, { form: { fields: 'username' } });
    selfName = handle(me.username);
    return selfName;
  }

  // Expiry can be checked locally and has a clear fix, so report it on its own
  function assertNotExpired() {
    if (token.expiresAt && token.expiresAt <= Date.now()) {
      throw new Error(`${name} token expired at ${new Date(token.expiresAt).toISOString()}. `
        + 'Fix: if you used npm run threads:auth, run it again (it rewrites the token file). '
        + 'Otherwise click Generate Access Token in the Meta dashboard, put the token in config as the '
        + `accessToken of this account, and delete ${tokenFile} so it is seeded again.`);
    }
  }

  // Refresh is allowed after 24 hours; each refresh resets the 60 days
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

  // A new container isn't ready at once: publishing right away gets HTTP 400 code 24.
  // code 24 means "not ready yet" on both the status query and publish. On any other
  // query error, stop waiting and let publish find out
  async function waitReady(id, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let delay = 500;
    let state;

    for (;;) {
      let st = null;
      try {
        st = await graph(`/${id}`, { form: { fields: 'status,error_message' } });
      } catch (err) {
        // For the first seconds even the GET gets code 24; same as IN_PROGRESS
        if (errorCode(err) !== 24) {
          log.debug(`${name} container ${id} status query failed: ${describeError(err)}`);
          return;
        }
        state = 'not-visible-yet';
      }

      if (st) {
        if (st.status === 'FINISHED') return;
        // These won't fix themselves, and a new container would have the same content
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

  // Create container → wait until ready → publish. Used for posts and both reply features;
  // replies just add reply_to_id
  async function publish(form) {
    const container = await graph(`/${owner}/threads`, { method: 'POST', form });
    if (!container.id) throw container;

    await waitReady(container.id);

    // After waiting this usually works first time; the loop only handles code 24. Other errors go
    // to the retry in index.js, so two layers of 3 don't become 9 requests
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
        log.warn(`${name} publish attempt ${attempt}/3 failed (container not ready): ${describeError(err)}`);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }

    // Before giving up, ask for the status: the reason is often in error_message.
    // FINISHED without error_message means the container is fine, so only debug
    try {
      const st = await graph(`/${container.id}`, { form: { fields: 'status,error_message' } });
      const line = `${name} container ${container.id} status=${st.status} ${st.error_message || ''}`.trim();
      if (st.status === 'FINISHED' && !st.error_message) log.debug(line);
      else log.warn(line);
    } catch { /* diagnostics only */ }
    throw lastErr;
  }

  // If the token lacks a scope, Threads only returns HTTP 500 code 1 "An unknown error occurred"
  // without saying which. So ask debug_token. Used by both watchers' startup checks
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
    // The Chinese account is 脆脆大笨钟; other languages use locale.brand (Big Ben)
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

      // A failed refresh doesn't mean the token is unusable (a fresh seed is under 24 hours old).
      // The /me call below decides
      try {
        await maybeRefresh();
      } catch (err) {
        log.warn(`${name} token refresh skipped: ${describeError(err)}`);
      }

      const me = await graph(`/${owner}`, { form: { fields: 'id,username' } });
      selfName = handle(me.username);

      // If the browser had the wrong account during threads:auth, English posts would go to the
      // Chinese account. With username set, stop here: ready stays false and nothing is posted
      if (username && username !== selfName) {
        throw new Error(`${name} token belongs to @${me.username}, not @${username} from config. `
          + `Probably the wrong account was logged in during threads:auth. Log in to the right one and run npm run threads:auth${key ? ` -- ${key}` : ''} again`);
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

// Main Chinese account. Both reply watchers use only this one
export const main = createAccount('', root);

// accounts.en → threads-en. App fields (appId / appSecret / redirectUri) are only at the top level;
// authorize.js and quota.js read them from config.threads
export const accounts = [
  main,
  ...Object.entries(root.accounts || {}).map(([key, cfg]) => createAccount(key, cfg)),
];
