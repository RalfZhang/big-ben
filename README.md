# 大笨钟

人人大笨钟复刻版，整点报时。

| 平台 | 账号 |
| --- | --- |
| 豆瓣 | https://www.douban.com/people/160931760/ |
| Threads | https://www.threads.com/@threads_big_ben |
| 长毛象 | <a rel="me" href="https://m.cmx.im/@cmxBigBen">https://m.cmx.im/@cmxBigBen</a> |


```
咣！×N 豆瓣大笨钟提醒您：北京时间 N 点整，2026年已悄悄溜走67.867%。
```

Threads 上还可以另开英 / 西 / 法账号，各按当地习惯报时（伦敦 / 墨西哥城 / 巴黎时间），
见 [deploy.md](deploy.md) 的「Threads 多语言账号」：

```
BONG BONG BONG — Big Ben here: it's 3 PM in London. 81.234% of 2026 has slipped away.
¡Dong! ¡Dong! ¡Dong! Big Ben les avisa: son las 3 de la tarde en Ciudad de México. Ya se fue el 81.234% de 2026.
Dong ! Dong ! Dong ! Ici Big Ben : il est 15 h à Paris. Déjà 81,234 % de l'année 2026 derrière nous.
```

Threads 上还会自动接话（可选，默认关）：问时间的回一句精确到秒的报时，
其他内容交给 Gemini 现编一句。见 [deploy.md](deploy.md) 的「评论区自动回复」。

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
