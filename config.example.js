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
    userId: ''        // 可留空，留空就用 /me
  },

  mastodon: {
    enabled: true,
    instance: 'https://m.cmx.im',
    accessToken: ''   // 偏好设置 → 开发 → 新建应用，scope 勾 write:statuses
  }
};
