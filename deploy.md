# 部署 / 运维

服务器上目录 `/path/to/big-ben/`，需要 Docker + Docker Compose。

## 首次部署

```bash
git clone <repo> && cd big-ben
cp config.example.js config.js   # 填入各平台凭据，见下方「账号准备」
docker compose up -d --build
```

`config.js` 只读挂载进容器，不进镜像也不进 git。

`data/` 是可写卷，放 Threads 的长效 token（`data/threads-token.json`）—— 这个文件丢了要重新人工授权，别跟着代码一起清；以及几个自动回复的处理进度（`threads-mentions.json`、`threads-replies.json`、`threads-replied.json`），这几个丢了无所谓，最坏是重复回几条。

## 账号准备

三个平台各自独立，没弄好的先在 `config.js` 里 `enabled: false`，不影响其它平台。

### 豆瓣

apikey/secret 从 Frodo APK 里提取，账号密码是普通豆瓣账号。字段见 `config.example.js`，其中 `device.doubanId`（douban_udid）**必填**，新版 App 每个请求都带，缺了会被拒。

### Threads

不需要申请「机器人账号」，但必须走官方 API，免费。

1. 注册普通 Threads 账号，**profile 必须设为 public** —— Token Generator 只给公开账号发 token，私密账号也无法自动续期
2. developers.facebook.com 建 app → 选 Threads use case → 把这个账号加成 **Threads Tester**，并在 Threads App 内接受邀请
3. **app 保持 development mode**：这样 `threads_basic` + `threads_content_publish` 无需 App Review、也无需 Tech Provider Verification（那两项是给「替别人账号发帖」准备的）
4. Use cases → Customize → **Permissions and features**：确认 `threads_basic` 和 `threads_content_publish` 都已添加，少了后者发不了帖
5. 同一页的 **Settings** 里抄三个值填进 `config.js`：

   | 页面上的字段 | config.js |
   | --- | --- |
   | Threads app ID | `threads.appId` |
   | Threads app secret（点 Show） | `threads.appSecret` |
   | 最下方 User Token Generator → **Generate Access Token** | `threads.accessToken` |

   `threads.userId` 留空即可，代码用 `/me`。**不需要** redirect callback URL —— 那是 OAuth 授权码流程用的，Token Generator 直接给长效 token，绕过整个流程。

首次启动会把 `threads.accessToken` 播种进 `data/threads-token.json`，**之后以这个文件为准**（config 里那份会一直停留在最初那次）。限额 250 帖/24h，我们 24 帖/天。进程每天 04:00 自动续期，每次重置 60 天，所以**离线不超过 59 天都能自己救回来**。

### Threads 被 at 自动回复（可选）

别人在 Threads 上 at 你时自动回一条当前时间。整份实现在 `platforms/threads/mentions.js`，
不要了就删掉那个文件，再删掉根目录 `index.js` 末尾那段带「被 at 自动回复」注释的 import 和调用，
别处不用动（同目录 `index.js` 为它开的三个 export 是 `post()` 自己也在用的，留着不是死代码）。

**先看这条，能省掉半天：后台 Settings 里那个 `Generate Access Token` 按钮拿不到这个权限。**
它发的 scope 是写死的一套 —— Threads API 首发时的五个（`threads_basic`、
`threads_content_publish`、`threads_manage_replies`、`threads_read_replies`、
`threads_manage_insights`），**跟你在 Permissions and features 里加了哪些完全无关**。
实测：use case 里只加 2 个权限，它照样发这 5 个。首发之后新增的权限
（`threads_manage_mentions`、`threads_delete`、`threads_keyword_search`、
`threads_location_tagging`、`threads_profile_discovery`、`threads_share_to_instagram`）
一个都拿不到，只能走正式 OAuth 流程在 scope 里显式要。

打开方法：

1. Use cases → Customize → **Permissions and features**，给这几个逐个点 Add：
   `threads_basic`、`threads_content_publish`、`threads_manage_mentions`
   （想接住「别人在回复里 at 你」再加 `threads_read_replies`）。
   没 Add 的 scope 在授权时会被拒
2. 同处 **Settings**，把**三个回调 URL 全部填上**，然后 Save：

   | 字段 | 填什么 |
   | --- | --- |
   | Redirect Callback URLs | `https://example.com/cb` |
   | Uninstall Callback URL | 同上（随便，不会被调用） |
   | Delete Callback URL | 同上 |

   **只填 Redirect 一个是存不上的**，会报 `Form can't be saved - Please verify all
   information is entered correctly`，但它不告诉你缺的是哪个字段。Meta 的后端要求三个
   同时有值 —— 这是已知行为，Meta 自己的社区论坛上有多人确认。
   Redirect 那格是 chip 输入框，输完要让它变成蓝色标签才算数。

   这个流程只走一次、纯手动，所以回调地址不需要真能收请求 —— 授权后从浏览器地址栏里
   抄 `code` 就行。填什么就原样抄进 `config.threads.redirectUri`，
   **两边差一个斜杠都会被拒**。

   （用 `example.com` 意味着那次跳转会把 `code` 发到一台你不拥有的服务器上。
   `code` 是一次性的、几分钟就失效，而且没有 app secret 换不出 token，风险可以忽略；
   介意的话换成你自己的域名或 GitHub Pages 地址，效果一样。）
3. 本机跑一次授权（在项目目录，不是容器里）：

   ```bash
   npm run threads:auth
   ```

   它会打印一个授权链接 → 用 bot 账号登录 Threads 并同意 → 浏览器跳到你填的 redirect URL
   （那页打不开是正常的）→ 把地址栏整条 URL 复制粘回终端。脚本会自动兑换成 60 天长效 token，
   当场打印实际拿到的权限，并写进 `data/threads-token.json`

4. `config.js` 的 `threads` 里加上 `mentions` 块（字段见 `config.example.js`），`enabled: true`
5. `docker compose up -d`

注意第 3 步之后 **`config.threads.accessToken` 里那份是旧的，但不用改** —— 代码以
`data/threads-token.json` 为准。反过来说，以后要是手滑删了那个文件，进程会拿 config 里
那份旧 token 重新播种，mentions 又会失效，自检会报出来。

拿到之后的续期跟以前一样：进程每天 04:00 自动续 60 天，离线不超过 59 天都能自己救回来，
不用再走一遍 OAuth。

**另一个坑：没拿到 `threads_manage_mentions` 的 Advanced Access 之前，`/mentions` 只返回
App Roles 里 Threads tester 发的 at，陌生人的 at 一条都查不到。** 想让朋友试，
得先把朋友加成 Threads Tester 并让 TA 在 Threads App 内接受邀请。
要对所有人生效，就得做商业验证 + 给这个权限单独提 App Review，那是另一件事了。

为什么是轮询不是 webhook：webhook 要公网 HTTPS 端点、签名校验、重试去重，还要求 app 处于
**Live Mode** 且关联的 business 已验证 —— 而上面第 3 步特意让 app 留在 development mode。
轮询没这些前提，延迟上界就是 `pollSeconds`，反而可预测；配额也不紧张，通用限额至少
48000 次/24h，60 秒一轮只花 1440 次。回复走的是独立的 1000 条/24h 限额，与 250 帖/24h 不冲突。

状态存在 `data/threads-mentions.json`（已在挂载的可写卷里），记着处理过的 mention id、
每人的冷却时间和当天回复数。删掉它只会让它从「刚才」重新开始，不会重复刷屏。

跟下面那个「评论区自动回复」共用两样东西，别把它们当成本功能的私有物：
`data/threads-replied.json`（判重账本）和 24 小时回复配额闸门
（`platforms/threads/quota.js`）。`mentions.dailyCap` 只是本功能的子上限。

### Threads 评论区自动回复（可选）

别人在你帖子底下回复时自动回一句：

| 对方说什么 | 回什么 |
| --- | --- |
| 问时间（「几点了」「现在什么时间」「报个时」…… 任何说法、任何语言） | `咣！脆脆大笨钟提醒您：现在是北京时间 2026-09-18 08:00:00。` |
| 其他任何内容 | 交给 Google Gemini 现编一句（略微调皮、有点抽象的老钟口吻） |

实现分两层：`platforms/threads/reply.js` 管「回不回、回什么」，
`services/ai.js` + `services/gemini.js` 管「问哪个模型」。以后想加第二家模型兜底，
照 `gemini.js` 的形状写一个模块塞进 `services/ai.js` 的 `PROVIDERS` 数组即可，顺序就是优先级。

不要了，两步删干净：删掉 `platforms/threads/reply.js` 和 `reply-try.js`，再删掉根目录
`index.js` 末尾那段带「评论区自动回复」注释的 import 和调用。
**`platforms/threads/quota.js` 和 `replied.js` 是跟 `mentions.js` 共用的，别跟着删。**

打开方法：

1. 权限：Meta 后台 Use cases → Customize → Permissions and features 里 Add 上
   `threads_read_replies`，然后跑一次 `npm run threads:auth`（跟上面 mentions 那节同一个流程，
   `authorize.js` 的默认 scope 里已经有它了）。读别人的回复要这个权限；**发**回复走的是
   发帖那条路，不需要额外权限
2. 模型 key：https://aistudio.google.com/apikey 点一下就有，免费档够用，填进 `config.ai.gemini.apiKey`
3. `config.threads.reply.enabled` 改成 `true`
4. **先干跑一遍**：照常拉取、照常编，但只把「准备回什么」打进日志，一条都不发 ——

   ```bash
   REPLY_DRY_RUN=1 docker compose up -d
   docker compose logs -f big-ben | grep dry-run
   ```

   看着顺眼了再 `docker compose up -d` 切回真实发送。注意干跑也会把看过的评论记进 seen，
   所以切回去之后不会把刚才那些补发一遍
5. 想单独调语气，不用等真有人回复：

   ```bash
   npm run threads:reply:try -- "打卡"
   npm run threads:reply:try -- "几点了"          # 走本地判断，连 AI 都不问
   npm run threads:reply:try -- "你是不是个机器人"  # 看看会不会破功
   ```

   这个只调 AI，完全不碰 Threads。人格提示词就在 `reply.js` 的 `persona()` 里

**跟 mentions 的分工**：mentions 查 `/mentions`（别人 @ 我，帖子可能发在任何地方），
本功能翻自己帖子的 `/conversation`（别人回我，不一定打 @）。
「在我帖子底下回复又打了 @」的评论两边都会看到，靠 `data/threads-replied.json`
这本共享账本判重，不会挂两条。另外 `reply.js` 还会顺便看一眼「这条评论底下是不是已经有我的回复了」
（`is_reply_owned_by_me` + `replied_to`），所以连状态文件一起丢了也不会重复回。

**一个意外的好处**：`/conversation` 读的是自己的帖子，不像 `/mentions` 那样卡
Advanced Access —— **陌生人的回复能正常拉到**。也就是说在没做 App Review 之前，
这个功能是唯一能对普通人生效的互动路径。

配额（这是本功能最需要盯的地方）：

- Threads 给「API 发出的回复」单独一档 **1000 条 / 24 小时滑动窗口**。
  整点敲钟不花这个池子 —— 发帖是另一档 250 条/24h，两者互不相干
- `quota.js` 不自己数，直接问服务端真实用量
  （`GET /me/threads_publishing_limit?fields=reply_quota_usage,reply_config`），
  缓存一分钟，再扣掉 `config.threads.replyQuotaHeadroom`（默认 100）。
  所以实际闸门是 **900 条/24h**，剩下 100 条留给手动操作和以后加的功能
- 问服务端而不是自己记，顺带解决三件事：重启后计数不清零、滑动窗口跟自然日对不上、
  在 App 里手动回的复也算进去
- 两个 watcher 共用这个闸门；`mentions.dailyCap` / `reply.dailyCap` 是各自的子上限，
  防的是「一路把一天的额度吃干」
- 万一 `threads_publishing_limit` 查不到，会退回各自的 `dailyCap` 兜着，并打一条 WARN，
  不会因此停摆

请求量：每轮 1 次「列最近的帖子」+ 每个有人回复过的帖子 1 次「拉会话」。
默认 60 秒一轮、只看最近 3 小时（也就是最多 3 条帖子），每轮最多 4 次，一天约 5800 次；
Threads 通用限额至少 48000 次/24h，加上 mentions 那路也还宽裕。

### 长毛象（m.cmx.im）

m.cmx.im 是**审核制注册**，且实例规则第 48 条明确要求：

> 4. 开设机器人账户需在注册理由中说明。

所以注册时的「您为什么想在 m.cmx.im 上注册」一栏必须同时做到：

- 说明这是整点报时的机器人账户
- 回答那道开放题「请推荐一部你最喜欢的书籍或影视作品，并简要说明原因」——**答非所问会直接被拒**

批准之后：

1. 账号设置里勾选「这是一个机器人账户」（进程启动时会检查，没勾会 WARN）
2. 偏好设置 → 开发 → 新建应用，scope **只勾 `write:statuses`**，页面直接给出 access token，填进 `config.js`

这个 token 不过期，不需要续期流程。实例规则第 35 条「机器人账户不得滥用服务器资源」—— 24 帖/天没问题。

## 更新

```bash
git pull
docker compose up -d --build   # 代码变了，重新构建
# 或
docker compose restart         # 只改了 config.js，无需重建
```

## 修完之后确认发布链路

某个平台出问题、你改完重启后，想确认「现在真的发得出去了」，就临时指定那个平台发一条「尝试启动中……」：

```bash
POST_ON_STARTUP=douban docker compose up -d
```

只有 douban 会发，另外两个平台不受打扰。可以填逗号分隔的多个平台名，或 `all` 全发：

```bash
POST_ON_STARTUP=douban,mastodon docker compose up -d
POST_ON_STARTUP=all docker compose up -d
```

完全重新构建且启动
```bash
POST_ON_STARTUP=all docker compose up -d --build
```

这个变量**没有写进 compose.yaml**（值是 `${POST_ON_STARTUP:-}`），所以是一次性的 —— 下次普通的 `docker compose up -d` 不会再发，不会变成每次重启都刷屏。写错平台名会 WARN 并忽略，不会静默不发。

想验证整点文案本身而不是重启通知，用 `--once` 发一条真实报时：

```bash
docker compose run --rm big-ben node index.js --once
```

注意 `--once` 发的文案写死了「北京时间N点整」，非整点跑出来的时间是不准的。

## 查看日志

日志统一为「北京时间 + 级别」格式，错误走 stderr：

```bash
docker compose logs --tail 50 -f big-ben   # 实时
docker compose logs big-ben 2>&1 | grep ERROR   # 只看错误
```

日志已配置滚动（单文件 10MB、保留 3 个），不会写满磁盘。

## 健康状态

容器内置 healthcheck：进程每 10 分钟刷新一次心跳，超过 15 分钟没更新即判定 unhealthy，配合 `restart: unless-stopped` 自动拉起。

```bash
docker compose ps            # 看 STATUS 是否 (healthy)
docker inspect --format '{{json .State.Health}}' big-ben
```

## 详细排查（开 debug）

临时提到 `debug`，能看到每个请求的 `method path -> status (耗时ms)`：

```bash
LOG_LEVEL=debug docker compose up -d   # 改 env 无需 --build
```

跟 `POST_ON_STARTUP` 一样是一次性的（compose.yaml 里写的是 `${LOG_LEVEL:-info}`），
下次普通 `docker compose up -d` 自动回到 `info`，不用记得改回来。

注意必须写在 `docker compose` 前面这一个命令里 —— 先 `export LOG_LEVEL=debug` 再单独
`docker compose restart` 也可以，但 `restart` 不重新读 environment，得用 `up -d`。

## 常见故障

日志里每个平台一行：`douban OK (id=..., 300ms)` 或 `douban FAILED (...): <原因>`。
一轮结束有 `round done: 2/3 succeeded`。**某个平台失败不影响其它平台**，也不会拖垮进程，下个整点自动重试（含重新登录）。

### `<平台> FAILED: ... cause=XXX`

这是网络层失败（不是 token 问题，token 失效各平台都会自动处理）。看 `cause=` 后面：

| cause | 含义 | 处理 |
| --- | --- | --- |
| `ENOTFOUND` | DNS 解析不了 frodo.douban.com | 给容器配 DNS（见下） |
| `ETIMEDOUT` / `ECONNRESET` / `UND_ERR_CONNECT_TIMEOUT` | 连得上但被掐断/超时，常见于海外服务器被豆瓣限制 | 配代理 |
| `CERT_*` / TLS 相关 | 证书/握手问题 | 检查系统时间、CA |

注意三个平台的网络方向正好相反：**豆瓣在海外服务器容易被限速，Threads / 长毛象在中国大陆服务器直接连不上**。同机跑三个平台的话，代理要能同时覆盖 `frodo.douban.com`、`graph.threads.net`、`m.cmx.im`。

容器内直接测连通性：

```bash
docker compose exec big-ben sh -c "wget -S -O- --timeout=15 https://frodo.douban.com/ 2>&1 | head"
docker compose exec big-ben sh -c "nslookup frodo.douban.com; cat /etc/resolv.conf"
```

**配 DNS**（`compose.yaml` 的 service 下）：

```yaml
    dns:
      - 223.5.5.5
      - 8.8.8.8
```

**配代理**（让容器内 fetch 走 HTTP 代理，Node 18+ 原生支持）：

```yaml
    environment:
      - LOG_LEVEL=info
      - HTTP_PROXY=http://proxy-host:port
      - HTTPS_PROXY=http://proxy-host:port
```

### `<平台> init failed (will retry hourly)`

凭据不对。进程**不会**因此退出（早期版本会 crash-loop），只是这个平台本轮跳过：

| 平台 | 常见原因 |
| --- | --- |
| douban | apikey/secret 或账号密码不对；`device.doubanId` 没填 |
| threads | token 过期（见下）；`threads_content_publish` 没加；账号被移出 Threads Testers |
| mastodon | access token 被吊销，或 scope 没勾 `write:statuses` |

改完 `config.js` 跑 `docker compose restart`。

### `threads publish attempt N/3 failed`

container 建好了但发布失败，日志下一行的 `container ... status=` 写了真实原因。三次重试都失败才算本轮失败，下个整点重来。

### `Threads token 已于 ... 过期`

离线超过 59 天，自动续期救不回来了。分两种：

- **用了「被 at 自动回复」** —— 重跑 `npm run threads:auth`，它直接重写 token 文件。
  **别走下面那条**：Token Generator 发的 scope 是固定的，重新播种会把
  `threads_manage_mentions` 弄丢，mentions 又会失效
- **只用整点报时** —— 去 Meta 后台 User Token Generator 重新 **Generate Access Token**，
  填进 `config.threads.accessToken`，然后**删掉 `data/threads-token.json`** 让它重新播种

最后 `docker compose up -d`。

### `threads token refresh skipped: ...`

只是警告不是故障 —— 续期没成，但手上这个 token 还能用（最常见是刚播种的 token 不满 24 小时，Meta 不让续）。下次 04:00 会再试。

### 长毛象重复发嘟

不会。每条嘟带 `Idempotency-Key: guang-<YYYY-MM-DDTHH>`，服务端保存 1 小时，同一整点内重试或进程重启都只会落一条。

### `mentions watcher 停了：token 里没有 threads_manage_mentions`

自检拦下来的。**别去点 Generate Access Token，那个按钮给不了这个权限**（原因见上面
「Threads 被 at 自动回复」一节）。跑 `npm run threads:auth` 走一次 OAuth，脚本最后会
打印实际拿到的权限，缺什么一目了然。

### `mentions poll failed: HTTP 500 {"code":1,"msg":"An unknown error occurred"}`

如果自检被绕过了（比如 `debug_token` 自己不通）还撞上这个，八成还是同一件事：
**Threads 在「edge 存在但 token 没这个 scope」时就回这个，不告诉你缺哪个权限。**
别被 500 骗去查网络或等它自己好 —— 直接问 token：

```bash
TOKEN=$(docker compose exec -T big-ben node -e "process.stdout.write(require('/app/data/threads-token.json').accessToken)")
curl -s "https://graph.threads.net/debug_token?input_token=$TOKEN&access_token=$TOKEN" | python3 -m json.tool
unset TOKEN
```

`scopes` 里没有 `threads_manage_mentions` 就按上一条修。注意这条命令会把 token 打到终端，
别往聊天记录/issue 里贴。

对照判断：`code=100 "Tried accessing nonexisting field"` 才是「这个 edge 真不存在」，
跟缺权限是两回事。

### mentions 日志一直是 `0 in window`

自检过了、也没报错，就是查不到 at：

- **没拿到 Advanced Access 时只有 Threads tester 的 at 能被查到** —— 确认 at 你的那个账号
  已经在 App Roles 里，且本人在 Threads App 内接受了邀请。这是最常见的原因
- 私密账号发的 at 永远查不到，这是 Meta 的设计
- 只有「@ 了你」才算 mention。别人在你帖子下回复但没打 @，走的是 replies，这条路查不到

开 `LOG_LEVEL=debug` 能看到每条被跳过的 mention 和具体理由（自己发的 / 太旧 / 冷却中 / 到日上限）。

### `reply watcher 停了：token 里没有 threads_read_replies`

跟 mentions 那条同一个套路：后台的 `Generate Access Token` 按钮给不了新权限，
去 Permissions and features 里 Add 上，然后 `npm run threads:auth` 重新授权。

### `ai: gemini 失败，静音 10 分钟：...`

不可重试的错才会静音（静音是为了别让每分钟一轮的 watcher 把同一条错刷几千行）。
看错误体里的 `msg`：

| 现象 | 原因 |
| --- | --- |
| HTTP 404 | `config.ai.gemini.model` 这个模型名不存在（Google 换代改名了），去 AI Studio 对一下 |
| HTTP 400 `API_KEY_INVALID` | key 抄错了或已撤销 |
| HTTP 403 | key 没开 Generative Language API，或所在地区不支持 |
| HTTP 429 | 免费档限速。**这个算可重试，不会静音**，下一轮自己再来 |

静音到期会自动再试一次，所以改完 `config.js` 重启更快，不改也不至于永久瘫掉。

### `gemini 没给出文本：maxOutputTokens 太小，思考把额度吃光了`

新一点的模型默认先「思考」，思考的 token 也从 `maxOutputTokens` 里扣。
在 `config.ai.gemini.generationConfig` 里调大 `maxOutputTokens`，或者干脆关掉思考
（2.5 系 `{ thinkingConfig: { thinkingBudget: 0 } }`，3.x 系
`{ thinkingConfig: { thinkingLevel: 'low' } }`）。这块是原样透传给 Gemini 的。

### `reply: ... 自曝身份，这条不发：...`

提示词里写了「绝对禁止承认自己是 bot」，但模型偶尔还是会破功。这是代码里那道防线
（`reply.js` 的 `SELF_OUTING`）拦下来的：这条不发，当成一次失败，下一轮重新生成 ——
温度是 1，重来一次大概率就正常了，连着三次都破功才放弃那条评论。

### 评论区一条都不回

按顺序看日志：

- `reply watcher off` —— `config.threads.reply.enabled` 没开
- `REPLY_DRY_RUN 开着` —— 干跑模式，本来就不发
- `reply: N/M 条帖子有回复, ... 0 回复, 0 跳过` —— 没人在窗口内回复。
  `maxAgeMinutes`（默认 30）之外的回复不补发，这是故意的：停机一天回来别把积压的全刷一遍
- `skip ... —— 冷却里 / 到上限了 / 配额用完了` —— 开 `LOG_LEVEL=debug` 就能看到每条被跳过的理由

### 时间不对

业务时间强制 `Asia/Shanghai`，与服务器时区无关；日志时间也是北京时间。若日志时间异常，检查镜像内 tzdata（Dockerfile 已安装）。
