# 大笨钟

人人大笨钟复刻版，整点报时。同一条文案同时发到三个平台：

| 平台 | 账号 | 接入方式 |
| --- | --- | --- |
| 豆瓣 | https://www.douban.com/people/160931760/ | 逆向 Frodo 移动端 API |
| Threads | — | 官方 Graph API（免费） |
| 长毛象 | https://m.cmx.im | 官方 REST API |

文案除品牌名外逐字一致：

```
咣！×N 豆瓣大笨钟提醒您：北京时间N点整，2026年已悄悄溜走67.867%。
```

每个平台在 `config.js` 里可以单独 `enabled: false` 关掉，互不影响；某个平台挂了不会拖累其它平台，下个整点自动重试。

## 快速开始

```bash
cp config.example.js config.js   # 填入各平台凭据
npm ci
npm run once                     # 立刻发一轮，验证配置
npm start                        # 常驻，整点发
```

部署、账号申请、故障排查见 [deploy.md](deploy.md)。

## 致谢
- http://page.renren.com/renren_big_ben
- https://github.com/DreaminginCodeZH/DoubanYearProgress

## License
MIT
