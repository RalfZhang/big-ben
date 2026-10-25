/**
 * 一次性的 Threads OAuth 授权，拿 User Token Generator 给不了的权限 ——
 * 那个按钮发的 scope 是写死的首发五件套，跟 use case 里加了什么无关，
 * threads_manage_mentions 这类只能走正式 OAuth 显式要。
 *
 * 前置：Meta 后台把 DEFAULT_SCOPES 逐个 Add，Redirect Callback URLs 填的
 * 那个 URL 原样抄进 config.threads.redirectUri（逐字一致）。详见 deploy.md。
 * 跑完直接写好该账号的 token 文件，之后进程每天 04:00 自己续期。
 *
 *   npm run threads:auth                  中文主账号 → data/threads-token.json
 *   npm run threads:auth -- en            config.threads.accounts.en → data/threads-en-token.json
 *   npm run threads:auth -- en --scopes=threads_basic,threads_content_publish
 *
 * 授权给的是浏览器里当前登着的那个 Threads 账号，所以多账号时用无痕窗口登对应的号。
 */
import readline from 'node:readline/promises';

import config from '../../config.js';
import { accounts, handle } from './index.js';

const cfg = config.threads || {};

// 前两个发帖必需，后两个分别给「被 at 自动回复」和「评论区自动回复」
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

// 授权码流程里每一步的报错都埋在 body 里，状态码本身说明不了什么
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

// 粘回来的可能是整条 redirect URL，也可能只是 code。
// Threads 会在 URL 末尾加个 "#_"，不剥掉会带进 code 里导致兑换失败
function extractCode(input) {
  const raw = input.trim().replace(/#_$/, '');
  if (!raw) return null;
  try {
    return new URL(raw).searchParams.get('code');
  } catch {
    return raw.includes('=') ? null : raw;   // 不是 URL 就当成裸 code
  }
}

const args = process.argv.slice(2);
const scopeArg = args.find((a) => a.startsWith('--scopes='));
const scopes = (scopeArg ? scopeArg.slice('--scopes='.length) : DEFAULT_SCOPES.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

// 认 en 也认 threads-en；不给就是中文主账号（它的 key 是空串）
const arg = args.find((a) => !a.startsWith('--')) || '';
const account = accounts.find((a) => a.key === arg.replace(/^threads-?/, ''));
if (!account) {
  die(`config 里没有「${arg}」这个 Threads 账号。可选：`
    + `${accounts.map((a) => a.key || '（不填）').join(' / ')}\n`
    + '  新账号先在 config.threads.accounts 里加上，比如 accounts: { en: { enabled: true } }');
}
const TOKEN_FILE = account.tokenFile;
const expected = account.username;

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

console.log(`\n要授权的账号：${account.name}${expected ? `（@${expected}）` : ''}`);
console.log('\n要申请的权限：');
for (const s of scopes) console.log(`  - ${s}`);
console.log(`\n用 ${expected ? `@${expected}` : `${account.name} 对应的`} 这个 Threads 账号登录（浏览器里登着别的号就开无痕窗口），`
  + '然后打开这个链接授权：\n');
console.log(authUrl.toString());
console.log('\n授权后浏览器会跳到 %s（打不开是正常的），', cfg.redirectUri);
console.log('把地址栏里那条完整 URL 复制粘贴到这里：\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('> ');
rl.close();

const code = extractCode(answer);
if (!code) die('没从里面解析出 code。粘贴整条 redirect URL，或者只粘 code= 后面那一段。');

// 授权码 → 短效 token（1 小时）
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

// 短效 → 长效（60 天）
const longUrl = new URL(`${GRAPH}/access_token`);
longUrl.searchParams.set('grant_type', 'th_exchange_token');
longUrl.searchParams.set('client_secret', cfg.appSecret);
longUrl.searchParams.set('access_token', short.access_token);
const long = await call('长效 token 兑换', longUrl.toString());
if (!long.access_token) die(`没拿到长效 token：${JSON.stringify(long)}`);

const expiresIn = Number(long.expires_in) || 60 * 24 * 3600;
console.log(`✓ 长效 token 到手，${Math.round(expiresIn / 86400)} 天后过期`);

// 当场验一下实际拿到的 scope，不然等进程跑起来又是那个毫无信息量的 500
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

// 写文件之前先看看 token 到底是谁的：浏览器里登错了号，英文报时就会发到中文账号上
const me = await call('/me', `${GRAPH}/v1.0/me?fields=id,username`
  + `&access_token=${encodeURIComponent(long.access_token)}`);
if (expected && handle(me.username) !== expected) {
  die(`这个 token 属于 @${me.username}，不是 config 里给 ${account.name} 写的 @${expected}。没有写入。\n`
    + '  浏览器里登对账号（或开无痕窗口）再跑一次。');
}
console.log(`\n✓ 这个 token 属于 @${me.username}`);
if (!expected) {
  console.log(`  确认这就是 ${account.name} 该用的号。`
    + `建议把 username: '${me.username}' 填进 config 里这个账号，以后登错号进程会直接拒绝启动。`);
  const confirm = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = (await confirm.question(`写入 ${TOKEN_FILE}？(y/N) `)).trim().toLowerCase();
  confirm.close();
  if (ok !== 'y' && ok !== 'yes') die('没有写入。');
}

account.saveToken(long.access_token, expiresIn);

console.log(`\n✓ 已写入 ${TOKEN_FILE}`);
console.log('\n注意：config 里这个账号的 accessToken 那份是旧的，但以 data/ 里这份为准，不用改。');
console.log('接下来：docker compose up -d\n');
