// 中文：北京时间，24 小时制，几点就咣几下（零点咣 24 下）。
// 品牌名按平台叫（豆瓣 / 脆脆 / 长毛象），由各 adapter 给，所以这里没有 brand
import mt from 'moment-timezone';

import { localTime, now } from '../text.js';

const tz = 'Asia/Shanghai';

export default {
  code: 'zh',
  tz,
  booting: '尝试启动中……',

  hourly(brand, at) {
    const { hour, year, progress } = localTime(at, tz);
    const h = hour || 24;
    return '咣！'.repeat(h) + `${brand}大笨钟提醒您：北京时间 ${h} 点整，${year} 年已悄悄溜走 ${progress}%。`;
  },

  // 「现在几点」的答复，精确到秒。两个 watcher（mentions.js / reply.js）共用
  clock(brand, at = now()) {
    return `咣！${brand}大笨钟提醒您：现在是北京时间 ${mt(at).tz(tz).format('YYYY-MM-DD HH:mm:ss')}。`;
  },
};
