// 复制为 config.js 后填入真实值（config.js 已在 .gitignore）。
// 每个平台可以单独 enabled: false 关掉。各项怎么拿见 deploy.md。
export default {
  douban: {
    enabled: true,
    api: {
      key: '',        // 豆瓣 frodo apikey
      secret: '',     // 对应 secret，用于请求签名
      device: {       // 伪装成 Android 客户端的设备信息，抓真机包来对
        sdkInt: 29,
        product: '',
        manufacturer: '',
        model: '',
        id: '',       // udid，任意稳定的十六进制串即可
        doubanId: ''  // douban_udid，新版必带
      }
    },
    username: '',     // 豆瓣账号（邮箱/手机号）
    password: ''      // 豆瓣密码
  },

  threads: {
    enabled: true,
    appId: '',        // Meta 后台 Use cases → Customize → Settings 里的 Threads app ID
    appSecret: '',    // 同一页的 Threads app secret（续期要用）
    accessToken: '',  // 同一页最下方 User Token Generator → Generate Access Token
    userId: '',       // 可留空，留空就用 /me
    // 只有跑 npm run threads:auth 才需要，值和后台 Redirect Callback URLs 里填的要逐字一致
    redirectUri: '',

    // 可选：别人 at 你时自动回一条当前时间。要 threads_manage_mentions，
    // 没拿到它的 Advanced Access 之前只查得到 Threads tester 发的 at（日志一直 0 条属于正常）
    mentions: {
      enabled: false,
      pollSeconds: 60,          // 轮询间隔，也就是被 at 后最坏等这么久（下限 15）
      maxAgeMinutes: 30,        // 超过这个岁数的 at 不回：停机一天回来别把积压的全刷一遍
      userCooldownSeconds: 120, // 同一个人的冷却
      dailyCap: 200             // 本功能每天回复上限（硬闸门见 replyQuotaHeadroom）
    },

    // 可选：别人在你帖子底下回复时自动回一句 —— 问时间的回报时，其余交给下面的 ai 现编。
    // 要 threads_read_replies，但不受 mentions 那个 Advanced Access 限制，陌生人的回复也拉得到
    reply: {
      enabled: false,           // 开之前先照 deploy.md 跑一遍 REPLY_DRY_RUN=1
      pollSeconds: 60,          // 轮询间隔（下限 15）
      lookbackHours: 3,         // 只翻最近这么久自己发的帖子（1~48）
      maxAgeMinutes: 30,        // 超过这个岁数的回复不回
      userCooldownSeconds: 60,  // 同一个人的冷却
      dailyCap: 300,            // 本功能每天回复上限
      maxTextLength: 480        // 回复截断长度（Threads 单条上限 500 字符）
    },

    // 两个自动回复功能共用 Threads 的「1000 条回复/24h」池子，这里预扣掉留给手动操作。
    // 实际闸门是「服务端真实用量 vs 1000 - 这个数」（platforms/threads/quota.js）。
    // 整点敲钟不花这个池子 —— 发帖是另一档 250 条/24h
    replyQuotaHeadroom: 100
  },

  mastodon: {
    enabled: true,
    instance: 'https://m.cmx.im',
    accessToken: ''   // 偏好设置 → 开发 → 新建应用，scope 勾 write:statuses
  },

  // 给「评论区自动回复」现编回复用的模型，只有 threads.reply.enabled 时才会被调用。
  // 加第二家兜底：照 services/gemini.js 的形状写个模块塞进 services/ai.js 的 PROVIDERS
  ai: {
    gemini: {
      enabled: true,
      apiKey: '',                       // https://aistudio.google.com/apikey，免费档够用
      model: 'gemini-3.5-flash-lite',   // 留空用默认。名字写错 Google 回 404
      timeoutMs: 20000,
      // 原样透传给 Gemini。想关掉「思考」省额度才需要动 ——
      // 2.5 系 { thinkingConfig: { thinkingBudget: 0 } }，3.x 系 { thinkingConfig: { thinkingLevel: 'low' } }
      generationConfig: {}
    }
  }
};
