// Douban: act as the Android app (Frodo) and call frodo.douban.com.
// The signature, User-Agent field order and body-vs-query params all match real app traffic.
// Capture the traffic again before changing them.
import crypto from 'node:crypto';

import config from '../config.js';
import { getLocale } from '../lib/locales/index.js';
import { log, describeError } from '../lib/log.js';

const cfg = config.douban || {};
let accessToken = null;

async function frodoRequest({ url, method = 'GET', form }) {
  method = method.toUpperCase();
  const u = new URL(url);
  const path = u.pathname;
  const device = cfg.api.device;

  const headers = {
    // Same as the real app, including field order
    'User-Agent':
      `api-client/1 com.douban.frodo/7.130.0.beta2(357) Android/${device.sdkInt}` +
      `  udid/${device.id}  douban_udid/${device.doubanId}` +
      ` model/${device.model} brand/${device.manufacturer.toLowerCase()}` +
      `  rom/android  network/wifi  platform/mobile  foldable/0 nd/1` +
      ` product/${device.product} vendor/${device.manufacturer}`,
  };

  if (path !== '/service/auth2/token' && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const isWrite = ['PATCH', 'POST', 'PUT'].includes(method);
  const body = isWrite ? new URLSearchParams(form || {}) : null;

  // Like the real app: common params go in the body for writes, in the query for reads
  const addParam = (name, value) => {
    if (isWrite) body.set(name, value);
    else u.searchParams.set(name, value);
  };

  addParam('udid', device.id);
  addParam('douban_udid', device.doubanId);   // required by newer app versions
  addParam('apikey', cfg.api.key);
  addParam('os_rom', 'android');
  addParam('channel', 'douban');   // lowercase, like the real app

  let signature = method;
  signature += `&${encodeURIComponent(decodeURIComponent(path).replace(/\/$/, ''))}`;
  if (headers.Authorization) {
    signature += `&${headers.Authorization.substring(7)}`;
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  signature += `&${timestamp}`;
  const sig = crypto.createHmac('sha1', cfg.api.secret).update(signature).digest('base64');
  addParam('_sig', sig);
  addParam('_ts', timestamp);

  const init = { method, headers, signal: AbortSignal.timeout(15000) };
  if (isWrite) {
    init.body = body.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const started = Date.now();
  log.debug(`douban ${method} ${path}`);
  const res = await fetch(u.toString(), init);
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }

  log.debug(`douban ${method} ${path} -> ${res.status} (${Date.now() - started}ms)`);

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.statusCode = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// The real app registers the device before logging in
async function registerDevice() {
  try {
    await frodoRequest({
      url: 'https://frodo.douban.com/api/v2/register_device',
      method: 'POST',
      form: { device_id: cfg.api.device.id },
    });
    log.info('douban device registered');
  } catch (err) {
    log.warn(`douban register_device failed (continuing): ${describeError(err)}`);
  }
}

async function authenticate() {
  const body = await frodoRequest({
    url: 'https://frodo.douban.com/service/auth2/token',
    method: 'POST',
    form: {
      client_id: cfg.api.key,
      client_secret: cfg.api.secret,
      redirect_uri: 'frodo://app/oauth/callback/',
      disable_account_create: 'false',
      grant_type: 'password',
      username: cfg.username,
      password: cfg.password,
    },
  });
  if (!body.access_token) throw body;
  accessToken = body.access_token;
  log.info(`douban authenticated as ${body.douban_user_name || body.douban_user_id}`);
}

// Newer app versions post via /api/v2/topic/post (the old status/create_status returns 999).
// content is Draft.js JSON
function buildContent(text) {
  return JSON.stringify({
    blocks: [{
      data: { align: 'left' },
      depth: 0,
      entityRanges: [],
      inlineStyleRanges: [],
      key: '',
      text,
      type: 'unstyled',
    }],
    entityMap: {},
  });
}

async function post(text, ctx, retried = false) {
  try {
    const body = await frodoRequest({
      url: 'https://frodo.douban.com/api/v2/topic/post',
      method: 'POST',
      form: {
        title: '',
        content: buildContent(text),
        original: '0',
        accessible: 'public',
        reply_limit: 'A',
        group_id: '0',
        send_status: '0',
        enable_photo_watermark: 'false',
        video_is_aigc: '0',
      },
    });
    return body && body.id;
  } catch (err) {
    const code = err.body && err.body.code;
    // 103 invalid token, 106 expired, 119 invalid refresh, 123 expired since password change
    if (!retried && [103, 106, 119, 123].includes(code)) {
      log.warn(`douban token invalid (code ${code}), re-authenticating`);
      await authenticate();
      return post(text, ctx, true);
    }
    throw err;
  }
}

export default {
  name: 'douban',
  locale: getLocale('zh'),
  brand: '豆瓣',
  enabled: Boolean(cfg.enabled),
  async init() {
    await registerDevice();
    await authenticate();
  },
  post,
};
