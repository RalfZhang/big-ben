# 部署 / 运维

服务器上目录 `/path/to/big-ben/`，需要 Docker + Docker Compose。

## 首次部署

```bash
git clone <repo> && cd big-ben
cp config.example.js config.js   # 填入各平台凭据，见下方「账号准备」
docker compose up -d --build
```

`config.js` 只读挂载进容器，不进镜像也不进 git。

`data/` 是可写卷，只放 Threads 的长效 token（`data/threads-token.json`）—— 这个文件丢了要重新人工授权，别跟着代码一起清。

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

`compose.yaml` 里把 `LOG_LEVEL` 改成 `debug`，能看到每个请求的 `method path -> status (耗时ms)`：

```yaml
    environment:
      - LOG_LEVEL=debug
```

```bash
docker compose up -d   # 改 env 无需 --build
```

排查完记得改回 `info`。

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

离线超过 59 天，自动续期救不回来了。去 Meta 后台 User Token Generator 重新 **Generate Access Token**，填进 `config.threads.accessToken`，然后**删掉 `data/threads-token.json`** 让它重新播种，最后 `docker compose restart`。

### `threads token refresh skipped: ...`

只是警告不是故障 —— 续期没成，但手上这个 token 还能用（最常见是刚播种的 token 不满 24 小时，Meta 不让续）。下次 04:00 会再试。

### 长毛象重复发嘟

不会。每条嘟带 `Idempotency-Key: guang-<YYYY-MM-DDTHH>`，服务端保存 1 小时，同一整点内重试或进程重启都只会落一条。

### 时间不对

业务时间强制 `Asia/Shanghai`，与服务器时区无关；日志时间也是北京时间。若日志时间异常，检查镜像内 tzdata（Dockerfile 已安装）。
