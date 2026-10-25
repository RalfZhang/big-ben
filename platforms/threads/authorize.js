/**
 * One-time Threads OAuth, for scopes the User Token Generator can't give: that button always
 * grants the same five launch scopes, whatever the use case has. Newer scopes such as
 * threads_manage_mentions must be requested through OAuth.
 *
 * Before: Add each of DEFAULT_SCOPES in the Meta dashboard, and copy the Redirect Callback URL
 * exactly into config.threads.redirectUri. See doc/deploy.md.
 * This writes the account's token file; the process then refreshes it daily at 04:00.
 *
 *   npm run threads:auth                  main Chinese account → data/threads-token.json
 *   npm run threads:auth -- en            config.threads.accounts.en → data/threads-en-token.json
 *   npm run threads:auth -- en --scopes=threads_basic,threads_content_publish
 *
 * The token is for whichever Threads account is logged in to the browser.
 * For other accounts, use a private window and log in to that account.
 */
import readline from 'node:readline/promises';

import config from '../../config.js';
import { accounts, handle } from './index.js';

const cfg = config.threads || {};

// The first two are needed to post; the last two are for mention replies and comment replies
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

// Each step puts its error in the body; the status code alone says little
async function call(label, url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* not JSON: report as is */ }
  if (!res.ok) {
    die(`${label} failed (HTTP ${res.status}):\n  ${JSON.stringify(body)}`);
  }
  return body;
}

// The input may be the full redirect URL or just the code.
// Threads adds "#_" to the URL; left in the code, it breaks the exchange
function extractCode(input) {
  const raw = input.trim().replace(/#_$/, '');
  if (!raw) return null;
  try {
    return new URL(raw).searchParams.get('code');
  } catch {
    return raw.includes('=') ? null : raw;   // not a URL: treat it as a bare code
  }
}

const args = process.argv.slice(2);
const scopeArg = args.find((a) => a.startsWith('--scopes='));
const scopes = (scopeArg ? scopeArg.slice('--scopes='.length) : DEFAULT_SCOPES.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

// Accepts en or threads-en. Empty means the main Chinese account (key '')
const arg = args.find((a) => !a.startsWith('--')) || '';
const account = accounts.find((a) => a.key === arg.replace(/^threads-?/, ''));
if (!account) {
  die(`No Threads account "${arg}" in config. Options: `
    + `${accounts.map((a) => a.key || '(empty)').join(' / ')}\n`
    + '  Add new accounts to config.threads.accounts first, e.g. accounts: { en: { enabled: true } }');
}
const TOKEN_FILE = account.tokenFile;
const expected = account.username;

if (!cfg.appId) die('config.threads.appId is empty');
if (!cfg.appSecret) die('config.threads.appSecret is empty (needed for the long-lived token)');
if (!cfg.redirectUri) {
  die('config.threads.redirectUri is empty.\n'
    + '  Add one in the Meta dashboard under Use cases → Customize → Settings → Redirect Callback URLs,\n'
    + '  then copy it exactly into config.js. Even one extra slash makes it fail.');
}

const authUrl = new URL('https://threads.net/oauth/authorize');
authUrl.searchParams.set('client_id', cfg.appId);
authUrl.searchParams.set('redirect_uri', cfg.redirectUri);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', scopes.join(','));

console.log(`\nAccount: ${account.name}${expected ? ` (@${expected})` : ''}`);
console.log('\nScopes to request:');
for (const s of scopes) console.log(`  - ${s}`);
console.log(`\nLog in to Threads as ${expected ? `@${expected}` : `the ${account.name} account`} `
  + '(use a private window if another account is logged in), then open this link:\n');
console.log(authUrl.toString());
console.log('\nAfter you authorize, the browser goes to %s (it is fine if the page does not load).', cfg.redirectUri);
console.log('Copy the full URL from the address bar and paste it here:\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('> ');
rl.close();

const code = extractCode(answer);
if (!code) die('No code found. Paste the full redirect URL, or just the part after code=.');

// Authorization code → short-lived token (1 hour)
const short = await call('code exchange', `${GRAPH}/oauth/access_token`, {
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
if (!short.access_token) die(`No short-lived token: ${JSON.stringify(short)}`);
console.log('\n✓ Got short-lived token');

// Short-lived → long-lived (60 days)
const longUrl = new URL(`${GRAPH}/access_token`);
longUrl.searchParams.set('grant_type', 'th_exchange_token');
longUrl.searchParams.set('client_secret', cfg.appSecret);
longUrl.searchParams.set('access_token', short.access_token);
const long = await call('long-lived token exchange', longUrl.toString());
if (!long.access_token) die(`No long-lived token: ${JSON.stringify(long)}`);

const expiresIn = Number(long.expires_in) || 60 * 24 * 3600;
console.log(`✓ Got long-lived token, expires in ${Math.round(expiresIn / 86400)} days`);

// Check the granted scopes now; otherwise the process later gets that useless 500
const dbg = await call('debug_token', `${GRAPH}/debug_token`
  + `?input_token=${encodeURIComponent(long.access_token)}`
  + `&access_token=${encodeURIComponent(long.access_token)}`);
const granted = dbg?.data?.scopes || [];
console.log('\nGranted scopes:');
for (const s of granted) console.log(`  ✓ ${s}`);
const missing = scopes.filter((s) => !granted.includes(s));
if (missing.length) {
  console.log('\nNot granted:');
  for (const s of missing) console.log(`  ✗ ${s}`);
  console.log('\nThese were probably not added under Use cases → Customize → Permissions and features.');
}

// Check whose token this is before writing it: with the wrong browser login,
// English posts would go to the Chinese account
const me = await call('/me', `${GRAPH}/v1.0/me?fields=id,username`
  + `&access_token=${encodeURIComponent(long.access_token)}`);
if (expected && handle(me.username) !== expected) {
  die(`This token belongs to @${me.username}, not @${expected} from config for ${account.name}. Nothing written.\n`
    + '  Log in to the right account in the browser (or use a private window) and run again.');
}
console.log(`\n✓ This token belongs to @${me.username}`);
if (!expected) {
  console.log(`  Make sure this is the right account for ${account.name}. `
    + `Tip: add username: '${me.username}' to this account in config, so a wrong account is refused at startup.`);
  const confirm = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = (await confirm.question(`Write ${TOKEN_FILE}? (y/N) `)).trim().toLowerCase();
  confirm.close();
  if (ok !== 'y' && ok !== 'yes') die('Nothing written.');
}

account.saveToken(long.access_token, expiresIn);

console.log(`\n✓ Wrote ${TOKEN_FILE}`);
console.log('\nThe accessToken in config is now old, but the file in data/ wins. No need to change it.');
console.log('Next: docker compose up -d\n');
