// 英语：伦敦时间（真 Big Ben 就报这个），12 小时制，跟真钟一样敲 1–12 下。
// 英国人管 Big Ben 的钟声就叫 the bongs
import mt from 'moment-timezone';

import { localTime, now } from '../text.js';

const tz = 'Europe/London';
const percent = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 3 });
const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full' });

const DST = {
  start: 'British Summer Time starts today. Have you put your clocks forward?',
  end: 'British Summer Time ends today. Have you put your clocks back?',
};

// 0 / 12 点说 midnight / noon，12 AM / 12 PM 英语母语者自己都分不清
function spoken(hour) {
  if (hour === 0) return 'midnight';
  if (hour === 12) return 'noon';
  return `${hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

export default {
  code: 'en',
  tz,
  brand: 'Big Ben',
  booting: 'Starting up…',

  hourly(brand, at) {
    const { hour, year, progress, dst } = localTime(at, tz);
    return Array(hour % 12 || 12).fill('BONG').join(' ')
      + ` — ${brand} here: it's ${spoken(hour)} in London. ${percent.format(progress / 100)} of ${year} has slipped away.`
      + (dst ? ` ${DST[dst]}` : '');
  },

  clock(brand, at = now()) {
    return `BONG — ${brand} here: it's ${mt(at).tz(tz).format('h:mm:ss A')} in London, ${date.format(at.valueOf())}.`;
  },
};
