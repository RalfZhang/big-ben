// 豆瓣：伪装 Android 客户端（Frodo）打 frodo.douban.com。
// 签名算法、UA 字段顺序、参数放 body 还是 query 都是对着真机抓包调出来的，改动前先抓包确认。
import crypto from 'node:crypto';

import config from '../config.js';
import { log, describeError } from '../lib/log.js';

const cfg = config.douban || {};
let accessToken = null;

async function frodoRequest({ url, method = 'GET', form }) {
  method = method.toUpperCase();
  const u = new URL(url);
  const path = u.pathname;
  const device = cfg.api.device;

  const headers = {
    // 对齐真机抓包，字段顺序也一致
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

  // 对齐真机：写请求的公共参数放 body，读请求放 query
  const addParam = (name, value) => {
    if (isWrite) body.set(name, value);
    else u.searchParams.set(name, value);
  };

  addParam('udid', device.id);
  addParam('douban_udid', device.doubanId);   // 新版必带（抓包发现）
  addParam('apikey', cfg.api.key);
  addParam('os_rom', 'android');
  addParam('channel', 'douban');   // 真机是小写 douban，不是 Douban

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

// 真机启动时会先注册设备再登录
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

// 新版发广播用 /api/v2/topic/post（旧的 status/create_status 已废弃，返回 999），
// 正文是 Draft.js 结构的 JSON
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
  brand: '豆瓣',
  enabled: Boolean(cfg.enabled),
  async init() {
    await registerDevice();
    await authenticate();
  },
  post,
};
