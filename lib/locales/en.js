// English: London time (home of the real Big Ben), 12-hour clock, 1–12 bongs like the real clock.
// "The bongs" is what the British call Big Ben's chimes.
import mt from 'moment-timezone';

import { localTime, now } from '../text.js';

const tz = 'Europe/London';
const percent = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 3 });
const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full' });

const DST = {
  start: 'British Summer Time starts today. Have you put your clocks forward?',
  end: 'British Summer Time ends today. Have you put your clocks back?',
};

// Say midnight / noon: even native speakers mix up 12 AM and 12 PM
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
