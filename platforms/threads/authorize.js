/**
 * 一次性的 Threads OAuth 授权，用来拿到 User Token Generator 给不了的权限。
 *
 * 为什么需要它：后台那个 Generate Access Token 按钮发的 scope 是写死的一套 ——
 * 就是 Threads API 首发时的 5 个（basic / content_publish / manage_replies /
 * read_replies / manage_insights），跟 use case 里加了哪些权限完全无关（实测：
 * use case 里只加 2 个，它照样发 5 个）。之后新增的权限，包括这个项目要用的
 * threads_manage_mentions，只能走正式 OAuth 流程、在 scope 里显式要。
 *
 * 用法：
 *   1. Meta 后台 Use cases → Customize → Permissions and features，
 *      把下面 DEFAULT_SCOPES 里的权限逐个 Add（没 Add 的 scope 授权时会被拒）
 *   2. 同一处 Settings → Redirect Callback URLs 填一个 URL，
 *      原样抄进 config.threads.redirectUri（两边必须逐字一致）
 *   3. npm run threads:auth
 *   4. 浏览器打开它给的链接（要用 bot 账号登录 Threads），点同意，
 *      浏览器会跳到你填的 redirect URL —— 那个页面打不开没关系，
 *      要的是地址栏里的 ?code=xxx，整条 URL 复制回来粘贴即可
 *
 * 跑完直接写好 data/threads-token.json，之后进程每天 04:00 自己续期，跟以前一样。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import config from '../../config.js';
import { TOKEN_FILE } from './index.js';

const cfg = config.threads || {};

// 这个项目实际用得上的四个。不需要「别人在回复里 at 你」的话可以去掉 read_replies
const DEFAULT_SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_manage_mentions',
  'threads_read_replies',
];

const GRAPH = 'https://graph.threads.net';

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// 授权码流程里每一步的报错都埋在 body 里，HTTP 状态码本身说明不了什么
async function call(label, url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* 不是 JSON 就原样报出来 */ }
  if (!res.ok) {
    die(`${label} 失败（HTTP ${res.status}）：\n  ${JSON.stringify(body)}`);
  }
  return body;
}

// 粘回来的可能是整条 redirect URL，也可能只是 code 本身。
// Threads 会在 URL 末尾加一个 "#_"，不剥掉就会带进 code 里导致兑换失败
function extractCode(input) {
  const raw = input.trim().replace(/#_$/, '');
  if (!raw) return null;
  try {
    return new URL(raw).searchParams.get('code');
  } catch {
    return raw.includes('=') ? null : raw;   // 不是 URL 就当成裸 code
  }
}

const scopes = (process.argv[2] || DEFAULT_SCOPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

if (!cfg.appId) die('config.threads.appId 是空的');
if (!cfg.appSecret) die('config.threads.appSecret 是空的（兑换长效 token 要用）');
if (!cfg.redirectUri) {
  die('config.threads.redirectUri 是空的。\n'
    + '  去 Meta 后台 Use cases → Customize → Settings → Redirect Callback URLs 填一个，\n'
    + '  再原样抄进 config.js —— 两边差一个斜杠都会被拒。');
}

const authUrl = new URL('https://threads.net/oauth/authorize');
authUrl.searchParams.set('client_id', cfg.appId);
authUrl.searchParams.set('redirect_uri', cfg.redirectUri);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', scopes.join(','));

console.log('\n要申请的权限：');
for (const s of scopes) console.log(`  - ${s}`);
console.log('\n用 bot 账号登录 Threads，然后打开这个链接授权：\n');
console.log(authUrl.toString());
console.log('\n授权后浏览器会跳到 %s（打不开是正常的），', cfg.redirectUri);
console.log('把地址栏里那条完整 URL 复制粘贴到这里：\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('> ');
rl.close();

const code = extractCode(answer);
if (!code) die('没从里面解析出 code。粘贴整条 redirect URL，或者只粘 code= 后面那一段。');

// 第一步：授权码 → 短效 token（1 小时）
const short = await call('授权码兑换', `${GRAPH}/oauth/access_token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: cfg.redirectUri,
    code,
  }).toString(),
});
if (!short.access_token) die(`没拿到短效 token：${JSON.stringify(short)}`);
console.log('\n✓ 短效 token 到手');

// 第二步：短效 → 长效（60 天）。短效只活 1 小时，这步必须紧接着做
const longUrl = new URL(`${GRAPH}/access_token`);
longUrl.searchParams.set('grant_type', 'th_exchange_token');
longUrl.searchParams.set('client_secret', cfg.appSecret);
longUrl.searchParams.set('access_token', short.access_token);
const long = await call('长效 token 兑换', longUrl.toString());
if (!long.access_token) die(`没拿到长效 token：${JSON.stringify(long)}`);

const expiresIn = Number(long.expires_in) || 60 * 24 * 3600;
console.log(`✓ 长效 token 到手，${Math.round(expiresIn / 86400)} 天后过期`);

// 验一下实际拿到的 scope —— 这整件事就是栽在「以为有、其实没有」上，
// 不当场确认一次，等进程跑起来又是那个毫无信息量的 500
const dbg = await call('debug_token', `${GRAPH}/debug_token`
  + `?input_token=${encodeURIComponent(long.access_token)}`
  + `&access_token=${encodeURIComponent(long.access_token)}`);
const granted = dbg?.data?.scopes || [];
console.log('\n实际拿到的权限：');
for (const s of granted) console.log(`  ✓ ${s}`);
const missing = scopes.filter((s) => !granted.includes(s));
if (missing.length) {
  console.log('\n没拿到的：');
  for (const s of missing) console.log(`  ✗ ${s}`);
  console.log('\n这些多半是没在 Use cases → Customize → Permissions and features 里 Add。');
}

fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
fs.writeFileSync(TOKEN_FILE, `${JSON.stringify({
  accessToken: long.access_token,
  expiresAt: Date.now() + expiresIn * 1000,
  // 刚签发的 token 不满 24 小时，Meta 不让续 —— 记成现在，让每天那次续期自己跳过
  refreshedAt: Date.now(),
}, null, 2)}\n`);

console.log(`\n✓ 已写入 ${TOKEN_FILE}`);
console.log('\n注意：config.threads.accessToken 里那份是旧的，但以 data/ 里这份为准，不用改。');
console.log('接下来：docker compose up -d\n');
