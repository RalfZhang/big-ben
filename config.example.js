// 复制为 config.js 后填入真实值（config.js 已在 .gitignore，不会提交）
// 每个平台可以单独 enabled: false 关掉，互不影响。
export default {
  douban: {
    enabled: true,
    api: {
      key: '',        // 豆瓣 frodo apikey
      secret: '',     // 对应 secret，用于请求签名
      device: {       // 伪装成 Android 客户端的设备信息
        sdkInt: 29,
        product: '',
        manufacturer: '',
        model: '',
        id: '',       // udid，任意稳定的十六进制串即可
        doubanId: ''  // douban_udid，新版 App 每个请求都带（抓包发现），必填
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
    // 只有跑 npm run threads:auth 才需要 —— 后台那个 Generate Access Token 按钮
    // 发的 scope 是写死的老一套，拿不到 threads_manage_mentions 这类新权限。
    // 值必须和后台 Settings → Redirect Callback URLs 里填的逐字一致。
    redirectUri: '',

    // 可选：别人 at 你时自动回一条当前时间。实现全在 platforms/threads/mentions.js，
    // 复用上面这份 token，需要在 Meta 后台额外勾上 threads_manage_mentions 并重新生成 token。
    // 注意：没拿到该权限的 Advanced Access 之前，只有加进 App Roles 的 Threads tester
    // 发的 at 能被查到，陌生人的 at 一条都拉不到 —— 日志一直是 0 条属于正常。
    mentions: {
      enabled: false,
      pollSeconds: 60,          // 轮询间隔，也就是被 at 后最坏等这么久才回（下限 15）
      maxAgeMinutes: 30,        // 超过这个岁数的 at 不回：停机一天回来别把积压的全刷一遍
      userCooldownSeconds: 120, // 同一个人的冷却，防一个人刷爆当天配额
      dailyCap: 200             // 每天回复上限（Threads 硬限额是 1000 条/24h）
    }
  },

  mastodon: {
    enabled: true,
    instance: 'https://m.cmx.im',
    accessToken: ''   // 偏好设置 → 开发 → 新建应用，scope 勾 write:statuses
  }
};
