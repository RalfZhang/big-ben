# Deploy and operations

Big Ben runs as one Docker container. The server needs Docker with Docker Compose.

## First deploy

On the server:

```bash
git clone https://github.com/RalfZhang/douban-guang big-ben
cd big-ben
cp config.example.js config.js
```

Fill in `config.js` (see [Accounts](#accounts)), then start:

```bash
docker compose up -d --build
```

Files that live only on the server:

| Path | Content | If lost |
| --- | --- | --- |
| `config.js` | Credentials. Mounted read-only; not in the image or git | Fill it in again |
| `data/threads*-token.json` | One Threads token per account | You must authorize again by hand. Don't delete them |
| `data/threads-mentions.json`, `threads-replies.json`, `threads-replied.json` | Auto-reply progress | No problem. At worst a few duplicate replies |

## Accounts

Each platform is independent. Set `enabled: false` for any platform that is not ready yet.

### Douban

Get the apikey and secret from the Frodo APK, and use a normal Douban account. The fields are in `config.example.js`. `device.doubanId` (douban_udid) is **required**: newer app versions send it with every request, and requests without it are rejected.

### Threads

Threads uses the official API. It is free, and you don't need a special bot account.

1. Create a normal Threads account and make the profile **public**. The Token Generator only works for public accounts, and private accounts can't refresh their token.
2. On developers.facebook.com, create an app with the Threads use case. Add the account as a **Threads Tester**, then accept the invite in the Threads app.
3. Keep the app in **development mode**. Then `threads_basic` and `threads_content_publish` need no App Review and no Tech Provider Verification (those are for posting for other people).
4. Under Use cases → Customize → **Permissions and features**, check that `threads_basic` and `threads_content_publish` are both added. You can't post without the second one.
5. On the **Settings** tab of the same page, copy three values into `config.js`:

   | Dashboard | `config.js` |
   | --- | --- |
   | Threads app ID | `threads.appId` |
   | Threads app secret (click Show) | `threads.appSecret` |
   | User Token Generator → **Generate Access Token** (at the bottom) | `threads.accessToken` |

   Leave `threads.userId` empty (the code uses `/me`). This way needs no redirect URL.

How the token works:

- On first start, `threads.accessToken` is copied into `data/threads-token.json`. **After that, only the file is used.** The token in `config.js` stays old.
- The process refreshes the token every day at 04:00. Each refresh gives 60 more days, so it recovers by itself after up to 59 days offline.
- Threads allows 250 posts per 24 hours. Big Ben posts 24 per day.

### Threads OAuth token

The **Generate Access Token** button always grants the same five launch scopes (`threads_basic`, `threads_content_publish`, `threads_manage_replies`, `threads_read_replies`, `threads_manage_insights`), whatever you added under Permissions and features. Newer scopes, such as `threads_manage_mentions`, need the OAuth flow in `npm run threads:auth`. You also use it to authorize the [other language accounts](#threads-in-other-languages).

1. Under Use cases → Customize → **Permissions and features**, click Add for each scope you need: `threads_basic`, `threads_content_publish`, plus `threads_manage_mentions` for mention replies and `threads_read_replies` for comment replies (and for mentions inside replies). Authorization refuses scopes that are not added here.
2. On the **Settings** tab, fill in **all three callback URLs**, then Save:

   | Field | Value |
   | --- | --- |
   | Redirect Callback URLs | `https://example.com/cb` |
   | Uninstall Callback URL | the same (never called) |
   | Delete Callback URL | the same |

   - With only the Redirect URL, saving fails with `Form can't be saved - Please verify all information is entered correctly`, and it doesn't say which field is missing. Meta needs all three.
   - The Redirect field turns each URL into a blue tag. The URL only counts once it becomes a tag.
   - Copy the exact same URL into `config.threads.redirectUri`. **Even one different slash makes it fail.**
   - The URL doesn't need to work: you copy the `code` from the browser's address bar. With `example.com`, the `code` goes to a server you don't own. It is single-use, expires in minutes, and is useless without the app secret, so the risk is small. You can use your own domain or a GitHub Pages URL instead.
3. Run this in the project folder on the host, not inside the container (it needs Node.js 18+ and `npm ci`). For another language, add its key, like `npm run threads:auth -- en`.

   ```bash
   npm run threads:auth
   ```

   It prints a link. **The token is for the Threads account logged in to the browser**, so use a private window and log in as the right account. After you approve, the browser goes to your redirect URL. The page won't load; that's fine. Paste the full URL from the address bar into the terminal. The script gets a 60-day token, prints the granted scopes, and writes `data/threads-token.json` (or `data/threads-<key>-token.json`).

After this, the `accessToken` in `config.js` is old, but you don't need to change it: the file in `data/` wins. If you ever delete the token file, though, the process seeds it again from that old token, and the new scopes are lost. The startup check will report it.

The daily refresh keeps the new scopes, so you only need OAuth again after more than 59 days offline.

### Threads in other languages

Top-level `config.threads` is the main Chinese account. English, Spanish and French each use their own Threads account, set in `config.threads.accounts`. They share the Meta app above (`appId`, `appSecret` and `redirectUri` are only set at the top level). Text and time zones are in `lib/locales/`.

| Key | Platform name | Time zone | Example |
| --- | --- | --- | --- |
| `en` | `threads-en` | London | BONG BONG BONG — Big Ben here: it's 3 PM in London. 81.234% of 2026 has slipped away. |
| `es` | `threads-es` | Mexico City | ¡Dong! ¡Dong! ¡Dong! Big Ben les avisa: son las 3 de la tarde en Ciudad de México. Ya se fue el 81.234% de 2026. |
| `fr` | `threads-fr` | Paris | Dong ! Dong ! Dong ! Ici Big Ben : il est 15 h à Paris. Déjà 81,234 % de l'année 2026 derrière nous. |

After London or Paris changes its clocks, the first post adds a reminder to change your clock. Mexico City and Beijing have no daylight saving time.

To add an account:

1. Create the Threads account and make it **public**.
2. In the Meta dashboard under App roles, add it as a **Threads Tester**. Accept the invite in the Threads app while logged in as this account.
3. In `config.js`, set `threads.accounts.en` to `{ enabled: true, username: '<its handle>' }`.
4. Run `npm run threads:auth -- en` (see [Threads OAuth token](#threads-oauth-token)). This writes `data/threads-en-token.json`. You can also use the Token Generator like for the main account and put the token in `accounts.en.accessToken`. Either way, check which account is logged in.
5. Check that it posts to the right account:

   ```bash
   POST_ON_STARTUP=threads-en docker compose up -d
   ```

Always set `username`. At startup the process checks that the token belongs to that account. If not, it logs `threads-en init failed` and posts nothing, so English posts never go to the Chinese account by mistake. `threads:auth` checks it too before it writes the file.

The auto-reply features below only run on the main Chinese account.

### Mastodon (m.cmx.im)

m.cmx.im approves each sign-up by hand, and its rules say a bot account must say so in the sign-up reason. So in the "why do you want to join" field:

- Say that this is a bot that posts the time every hour.
- Also answer the open question (recommend a book, film or show you love, and say why). **Off-topic answers are rejected.**

After approval:

1. In account settings, mark the account as a bot. The process warns at startup if you don't.
2. Preferences → Development → New application. Select **only `write:statuses`**. The page shows the access token. Put it in `config.js`.

The token never expires, so there is nothing to refresh. The instance forbids bots that abuse server resources; 24 posts per day is fine.

Other languages go in `config.mastodon.accounts` (`en: { enabled: true, instance, accessToken }`), with platform names like `mastodon-en`. Each post sets the matching `language`. m.cmx.im is a Chinese instance, so find an instance that **clearly allows bot accounts**, and read its rules first. (botsin.space, which was made for bots, closed at the end of 2024.)

## Threads auto replies (optional)

Two optional features. Both run only on the main Chinese account.

| Feature | Watches | Replies with | File |
| --- | --- | --- | --- |
| Mention replies | Posts that @mention you (`/mentions`) | The current time | `platforms/threads/mentions.js` |
| Comment replies | Comments under your posts (`/conversation`) | The time for time questions, otherwise a Gemini reply | `platforms/threads/reply.js` |

A comment under your post that also @mentions you shows up in both. The shared record in `data/threads-replied.json` makes sure it gets only one reply.

To remove a feature, delete its file, and its `import` and start call at the end of `index.js`. Keep `quota.js` and `replied.js`: both features use them.

### Mention replies

1. Get a token with `threads_manage_mentions` ([Threads OAuth token](#threads-oauth-token)).
2. In `config.js`, add a `mentions` block to `threads` with `enabled: true` (fields are in `config.example.js`).
3. Run `docker compose up -d`.

**Limit:** until you get Advanced Access for `threads_manage_mentions`, `/mentions` only returns mentions from Threads testers. Mentions from strangers never show up. To let a friend test it, add them as a Threads Tester and have them accept the invite in the Threads app. To make it work for everyone, you need business verification and App Review for this scope.

### Comment replies

| They say | Big Ben replies |
| --- | --- |
| Asks the time (any wording, any language) | `咣！脆脆大笨钟提醒您：现在是北京时间 2026-09-18 08:00:00。` |
| Anything else | A short reply from Google Gemini, as a playful old clock |

Replies from strangers work too: unlike `/mentions`, comments on your own posts have no Advanced Access limit. So before App Review, this is the only feature that works for everyone.

Setup:

1. Add `threads_read_replies` under Permissions and features, then run `npm run threads:auth` ([Threads OAuth token](#threads-oauth-token)). Sending replies needs no extra scope.
2. Get a free API key at https://aistudio.google.com/apikey and put it in `config.ai.gemini.apiKey`.
3. Set `config.threads.reply.enabled` to `true`.
4. Do a dry run first. It works as usual, but only logs the replies:

   ```bash
   REPLY_DRY_RUN=1 docker compose up -d
   docker compose logs -f big-ben | grep dry-run
   ```

   When the replies look good, run `docker compose up -d` to send for real. Comments seen during the dry run don't get a reply later.

To tune the voice without waiting for real comments, use `threads:reply:try`. It only calls the AI, never Threads. Quote each message. With several messages, they form a thread (them, you, them, …), and the last one is the comment to answer. Time questions like "几点了" are answered locally, without the AI.

```bash
npm run threads:reply:try -- "打卡"
npm run threads:reply:try -- "几点了"
npm run threads:reply:try -- "你是不是个机器人"
npm run threads:reply:try -- "你这钟准吗" "我走得比你上班还准时" "好吧"
```

The persona prompt is `persona()` in `reply.js`. To add a fallback model, write a module like `services/gemini.js` and add it to `PROVIDERS` in `services/ai.js`. The array order is the priority.

How it decides:

- **Not every comment gets a reply.** If you already replied in the thread and they just close it ("好吧", "谢谢", only emoji), Big Ben stays quiet without asking the AI. Otherwise the AI decides, and answers `__SKIP__` when there is nothing worth answering (small talk, only emoji, ads, spam). The log shows `reply: no reply to @user [closing/local] …`.
- **Context:** the AI also gets the original post and up to `contextMessages` earlier messages in the thread (default 4, 0 = off). This uses data that was already fetched, so it costs no extra requests.
- Only comments from the last `maxAgeMinutes` (default 30) get a reply, so after downtime it doesn't answer the backlog.

### Reply quota

- Threads allows **1000 API replies per rolling 24 hours**. This is separate from the 250 posts, so the hourly posts don't use it.
- `platforms/threads/quota.js` asks the server for the real usage and keeps `config.threads.replyQuotaHeadroom` (default 100) free for manual replies. So the real limit is **900 replies per 24 hours**. Replies you make in the app count too.
- Both features share this limit. `mentions.dailyCap` and `reply.dailyCap` are smaller limits for each feature.
- If the server usage can't be read, each feature falls back to its `dailyCap` and logs a WARN.

## Updating

### Automatic deploy

**A push to master deploys automatically** (`.github/workflows/deploy.yml`). GitHub Actions connects to the VPS over ssh and runs `git pull --ff-only && ./deploy.sh`. `deploy.sh` builds, restarts (but not at the top of the hour), and then watches the new container for 20 seconds to make sure it doesn't keep crashing.

- Results are on the repo's Actions page. GitHub emails you when it fails.
- Pushes that only change `*.md` files don't deploy.
- To run it again by hand: `gh workflow run deploy`.

### Manual deploy

On the VPS:

```bash
git pull && ./deploy.sh
```

If you only changed `config.js`, a restart is enough:

```bash
docker compose restart
```

From :58 to :02 (Beijing time), `deploy.sh` waits until :03 before it restarts. The new container needs time to log in to each platform, and a post missed at :00 is not sent later. So a deploy that waits a few minutes is normal.

### One-off settings

These environment variables only apply to the `docker compose up -d` you set them on. The next plain `docker compose up -d`, including an automatic deploy, resets them.

| Variable | Use |
| --- | --- |
| `POST_ON_STARTUP` | Post a startup notice ([Check a platform](#check-a-platform)) |
| `LOG_LEVEL=debug` | Log every request as `method path -> status (ms)` |
| `REPLY_DRY_RUN=1` | Log comment replies instead of sending them |

Use `up -d` to apply them. `docker compose restart` doesn't read new environment values.

To keep `LOG_LEVEL` or `REPLY_DRY_RUN` across deploys (for example while you tune the prompt), write it into `.env` in the project folder on the VPS, like `REPLY_DRY_RUN=1`. Compose reads this file automatically, and `git pull` doesn't touch it (it is untracked). Delete it when you are done. Don't put `POST_ON_STARTUP` there, or every deploy posts a notice.

### Set up automatic deploy

Before you start: the VPS SSH port must be open to the internet (GitHub's runners connect to it), and the project must already run (see [First deploy](#first-deploy)).

Run all steps below in **one** terminal window on your Mac, in the project folder, in order. The variables only exist in that window. The command blocks have no comments, because zsh doesn't accept `#` comments in typed commands by default.

First set four variables:

- `VPS`: the VPS address.
- `VPS_USER`: the user that runs `docker compose` on the VPS. It must be root or in the `docker` group, because sudo can't be used here.
- `VPS_PORT`: the SSH port.
- `VPS_DIR`: the full path of the project on the VPS. Run `pwd` in the project folder there to get it. Don't use `~/...`, because your Mac would expand the `~`.

If you log in with an ssh alias, `ssh -G <alias> | grep -E '^(hostname|user|port) '` shows the real values of the first three.

```bash
VPS=1.2.3.4 VPS_USER=root VPS_PORT=22 VPS_DIR=/path/to/big-ben
```

Check that you can log in, the folder is right, `git fetch` works without your Mac's ssh agent, and docker works without sudo. The automatic deploy needs all of these:

```bash
ssh -p "$VPS_PORT" "$VPS_USER@$VPS" "cd $VPS_DIR && git remote get-url origin && SSH_AUTH_SOCK= git fetch --dry-run && git status --short && docker ps --format '{{.Names}} {{.Status}}'"
```

The first line should be the repo URL and the last line `big-ben Up ...`. If you see an error, or a changed file like ` M compose.yaml` in between, fix it first (see [When automatic deploy fails](#when-automatic-deploy-fails)). Untracked files (`??`, like `.env`) are fine.

If all is fine, paste this whole block:

```bash
D=$(mktemp -d) && ssh-keygen -q -t ed25519 -N '' -C big-ben-deploy -f "$D/key"
printf '%s\n' "restrict,command=\"cd $VPS_DIR && git pull --ff-only && ./deploy.sh\" $(cat "$D/key.pub")" \
  | ssh -p "$VPS_PORT" "$VPS_USER@$VPS" 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'
gh secret set DEPLOY_SSH_KEY < "$D/key"
gh secret set DEPLOY_HOST --body "$VPS"
gh secret set DEPLOY_USER --body "$VPS_USER"
gh secret set DEPLOY_PORT --body "$VPS_PORT"
ssh-keyscan -p "$VPS_PORT" "$VPS" | gh secret set DEPLOY_KNOWN_HOSTS
rm "$D/key" "$D/key.pub" && rmdir "$D"
```

What it does:

- Creates a deploy key and adds its public key to `authorized_keys` on the VPS, **locked with `command=`**. This key can only run `git pull` and `./deploy.sh`: no shell, no port forwarding. `git pull` is in the key and not in `deploy.sh`, so each deploy runs the `deploy.sh` it just pulled. If a push breaks `deploy.sh`, the next push can still fix it.
- Saves the private key, address, user and port as Actions secrets, then deletes the local key. The address is a secret too because the repo is public: anyone can read the Actions logs, and secrets are masked there.
- Reads the VPS host key once from your Mac and saves it. Actions checks it on every connection, which blocks man-in-the-middle attacks. (Many guides read the key inside Actions each time, which checks nothing.)

Then check that `gh secret list` shows five `DEPLOY_*` secrets. Run `gh workflow run deploy` (or push something), and follow it with `gh run watch`.

To turn it off, delete the line ending in `big-ben-deploy` from `authorized_keys` on the VPS. The key on GitHub stops working at once.

### When automatic deploy fails

| Log shows | Cause and fix |
| --- | --- |
| `Permission denied (publickey)` | The `authorized_keys` line is wrong, or `DEPLOY_USER` is not the user that has the key |
| `Host key verification failed` | The VPS host key changed (for example after a reinstall). Run the `ssh-keyscan` line again |
| `Connection timed out` | GitHub can't reach the VPS: the firewall only allows your IP, or fail2ban blocked it |
| `would be overwritten by merge` | A tracked file was changed on the VPS (for example DNS or proxy settings in `compose.yaml`), and the push changes it too. It is **not overwritten on purpose**: losing the proxy settings breaks everything. Move VPS-only settings to `compose.override.yaml` (see [Troubleshooting](#troubleshooting)), then run `git checkout -- compose.yaml` |
| `Not possible to fast-forward` | The history doesn't match: a force push, or local commits on the VPS. Check `git log` on the VPS and fix it by hand |
| `git@github.com: Permission denied` | On the VPS, `git pull` used the ssh agent forwarded from your Mac, which isn't there during a deploy. The repo is public, so switch to HTTPS: `git remote set-url origin https://github.com/RalfZhang/douban-guang` |
| `Container is not stable` | The new code crashes at startup. Check `docker compose logs big-ben` on the VPS, fix it, and push again |

## Checking and logs

### Check a platform

After you fix a platform, post a startup notice ("尝试启动中……", or its translation) to only that platform:

```bash
POST_ON_STARTUP=douban docker compose up -d
```

You can list several platforms with commas, or use `all`. Each language account is its own platform (`threads-en`, `mastodon-en`, …). The `platforms:` line in the startup log shows all names. A wrong name logs a WARN.

```bash
POST_ON_STARTUP=threads-en,threads-fr docker compose up -d
POST_ON_STARTUP=all docker compose up -d --build
```

To test the real hourly post instead, post one now:

```bash
docker compose run --rm big-ben node index.js --once
```

The post always says it is "N o'clock", so when you run it between hours, the time in the post is not exact.

### Logs

Each log line has the Beijing time and a level. Warnings and errors go to stderr.

```bash
docker compose logs --tail 50 -f big-ben
docker compose logs big-ben 2>&1 | grep ERROR
```

Logs rotate (3 files of 10 MB), so they can't fill the disk. For more detail, use `LOG_LEVEL=debug` (see [One-off settings](#one-off-settings)).

### Health

The process updates a heartbeat file every 10 minutes. If the heartbeat is older than 15 minutes, Docker marks the container unhealthy.

```bash
docker compose ps
docker inspect --format '{{json .State.Health}}' big-ben
```

`STATUS` should show `(healthy)`. Note: plain Docker doesn't restart unhealthy containers. `restart: unless-stopped` only restarts the container when the process exits.

## Troubleshooting

Each platform logs one line per post: `douban OK (id=..., 300ms)` or `douban FAILED (...): <reason>`. Each round ends with `round done: 2/3 succeeded`. **A failed platform doesn't affect the others** and doesn't stop the process. It tries again at the next hour, and logs in again first.

### `<platform> FAILED: ... cause=XXX`

A network error. It is not a token problem: each platform handles invalid tokens by itself. Check the `cause=`:

| cause | Meaning | Fix |
| --- | --- | --- |
| `ENOTFOUND` | DNS can't resolve the host | Set DNS for the container (below) |
| `ETIMEDOUT` / `ECONNRESET` / `UND_ERR_CONNECT_TIMEOUT` | Connected, but cut off or timed out. Common for Douban on servers outside China | Use a proxy (below) |
| `CERT_*` / TLS errors | Certificate or handshake problem | Check the system time and CA certificates |

The platforms need opposite networks: **Douban is often throttled from servers outside China, and Threads and Mastodon are blocked in mainland China.** If one server runs all of them, the proxy must cover `frodo.douban.com`, `graph.threads.net` and `m.cmx.im` (and `generativelanguage.googleapis.com` for comment replies).

Test from inside the container:

```bash
docker compose exec big-ben sh -c "wget -S -O- --timeout=15 https://frodo.douban.com/ 2>&1 | head"
docker compose exec big-ben sh -c "nslookup frodo.douban.com; cat /etc/resolv.conf"
```

Put DNS and proxy settings in `compose.override.yaml` next to `compose.yaml`. Compose merges this file automatically, and it is untracked, so `git pull` doesn't touch it. Keep only the parts you need:

```yaml
services:
  big-ben:
    dns:
      - 223.5.5.5
      - 8.8.8.8
    environment:
      - HTTP_PROXY=http://proxy-host:port
      - HTTPS_PROXY=http://proxy-host:port
      - NODE_USE_ENV_PROXY=1
```

`NODE_USE_ENV_PROXY=1` is required: without it, Node's `fetch` ignores `HTTP_PROXY` and `HTTPS_PROXY`.

### `<platform> init failed (will retry hourly)`

The credentials are wrong. The process does **not** exit. It skips this platform until the next hour.

| Platform | Common causes |
| --- | --- |
| douban | Wrong apikey / secret or username / password; `device.doubanId` is missing |
| threads | Token expired (below); `threads_content_publish` not added; the account was removed from Threads Testers; the token belongs to a different account than `username` |
| mastodon | The access token was revoked, or `write:statuses` was not selected |

After you fix `config.js`, run `docker compose restart`.

### `threads publish attempt N/3 failed`

The container was created, but publishing failed. A later `container ... status=` line shows the real reason. The round only fails after three attempts, and the next hour tries again.

### `threads token expired at ...`

The bot was offline for more than 59 days, so the daily refresh couldn't save the token. There are two fixes:

- **If you use auto replies or `threads:auth`:** run `npm run threads:auth` again. It rewrites the token file. **Don't use the other fix**: a Token Generator token would lose `threads_manage_mentions`.
- **If you only post hourly:** click **Generate Access Token** again in the Meta dashboard, put the token in `config.threads.accessToken`, and **delete `data/threads-token.json`** so it is seeded again.

Then run `docker compose up -d`. For a language account, the file is `data/threads-<key>-token.json`, and the config field is `accounts.<key>.accessToken`.

### `threads token refresh skipped: ...`

A warning, not an error. The refresh failed, but the token still works. Usually the token was seeded less than 24 hours ago, and Meta doesn't allow a refresh yet. It tries again at 04:00.

### Double posts on Mastodon

This can't happen. Each post sends an `Idempotency-Key` for the current hour, and the server keeps it for 1 hour. So retries and restarts within the same hour post only once.

### `mentions watcher stopped` / `reply watcher stopped: token lacks ...`

The startup check found a missing scope (`threads_manage_mentions` or `threads_read_replies`). Add the scope under Permissions and features, then run `npm run threads:auth` ([Threads OAuth token](#threads-oauth-token)). At the end it prints the granted scopes, so you can see what is missing. Don't use Generate Access Token: it can't grant `threads_manage_mentions`.

### `mentions poll failed: HTTP 500 {"code":1,"msg":"An unknown error occurred"}`

If you see this anyway (for example, the startup check itself couldn't run), it is most likely still a missing scope. **Threads returns this 500 when the token lacks the scope for an endpoint**, and it doesn't say which scope. Don't debug the network or wait for it to pass. Ask about the token instead, on the VPS:

```bash
TOKEN=$(docker compose exec -T big-ben node -e "process.stdout.write(require('/app/data/threads-token.json').accessToken)")
curl -s "https://graph.threads.net/debug_token?input_token=$TOKEN&access_token=$TOKEN" | python3 -m json.tool
unset TOKEN
```

If `scopes` doesn't include `threads_manage_mentions`, fix it as in the previous section. This command prints the token to the terminal, so don't paste the output into chats or issues.

A different error, `code=100 "Tried accessing nonexisting field"`, means the endpoint really doesn't exist. That is not a scope problem.

### Mention log always shows `0 in window`

The check passed and there are no errors, but no mentions show up:

- **Without Advanced Access, only mentions from Threads testers show up.** Check that the account that mentions you is in App roles and accepted the invite in the Threads app. This is the most common cause.
- Mentions from private accounts never show up. This is how Meta designed it.
- Only an @mention counts. A reply under your post without an @ is handled by comment replies.

With `LOG_LEVEL=debug`, every skipped mention is logged with the reason (own post, too old, cooldown, daily cap).

### `ai: gemini failed, muted for 10 minutes: ...`

Only errors that can't be retried mute the provider. This stops a watcher that runs every minute from logging the same error thousands of times. Check the error:

| Error | Cause |
| --- | --- |
| HTTP 404 | The model in `config.ai.gemini.model` doesn't exist (Google renamed it). Check the name in AI Studio |
| HTTP 400 `API_KEY_INVALID` | The key is wrong or was revoked |
| HTTP 403 | The key doesn't have the Generative Language API, or your region isn't supported |
| HTTP 429 | Free-tier rate limit. **This can be retried, so it is not muted.** The next round tries again |

When the mute ends, it tries again by itself. A restart after you fix `config.js` is faster.

### `gemini returned no text: maxOutputTokens is too small, ...`

Newer models "think" first, and thinking uses the same `maxOutputTokens` budget. Raise `maxOutputTokens` in `config.ai.gemini.generationConfig`, or turn thinking off: `{ thinkingConfig: { thinkingBudget: 0 } }` for 2.5 models, `{ thinkingConfig: { thinkingLevel: 'low' } }` for 3.x models. This object is passed to Gemini as is.

### `... said it is a bot, not sending: ...`

The prompt forbids admitting to being a bot, but the model sometimes slips. The `SELF_OUTING` check in `reply.js` blocks that reply and counts it as a failure. The next round writes a new one, which is usually fine. After three failures it gives up on that comment.

### No comment replies at all

Check the log in this order:

- `reply watcher off`: `config.threads.reply.enabled` is not `true`.
- `REPLY_DRY_RUN is on`: this is a dry run, so nothing is sent.
- Otherwise, use `LOG_LEVEL=debug`. Each round then logs a summary (`reply: N/M posts with replies, ... to check, ...`) and the reason for each skipped comment (cooldown, daily cap, quota). If nothing is "to check", there were no new comments. Comments older than `maxAgeMinutes` (default 30) are ignored on purpose, so after downtime the backlog doesn't get replies.

### Wrong time

Chinese posts always use `Asia/Shanghai`. Other languages use the `tz` in their `lib/locales/` file. Neither depends on the server's time zone. Logs always use Beijing time. If log times look wrong, check tzdata in the image (the Dockerfile installs it).
