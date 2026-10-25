// Chinese: Beijing time, 24-hour clock, one 咣 per hour (24 at midnight).
// The brand depends on the platform (豆瓣 / 脆脆 / 长毛象), so the adapters give it.
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

  // Answer to "what time is it", to the second. Used by mentions.js and reply.js
  clock(brand, at = now()) {
    return `咣！${brand}大笨钟提醒您：现在是北京时间 ${mt(at).tz(tz).format('YYYY-MM-DD HH:mm:ss')}。`;
  },
};
