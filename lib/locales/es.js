// 西语：墨西哥城时间（说西语的人最多的国家，2022 年起不再实行夏令时），
// 12 小时制 + 时段（las 3 de la tarde，西班牙和拉美都这么说），敲 1–12 下。
// 数字跟墨西哥的习惯：小数点，% 前不空格
import mt from 'moment-timezone';

import { localTime, now } from '../text.js';

const tz = 'America/Mexico_City';
const percent = new Intl.NumberFormat('es-MX', { style: 'percent', maximumFractionDigits: 3 });
const date = new Intl.DateTimeFormat('es-MX', { timeZone: tz, dateStyle: 'full' });
const time = new Intl.DateTimeFormat('es-MX', { timeZone: tz, timeStyle: 'medium' });

// 1 点是单数：es la una
function spoken(hour) {
  const h = hour % 12 || 12;
  const period = hour === 0 ? 'de la noche'
    : hour < 6 ? 'de la madrugada'
      : hour < 12 ? 'de la mañana'
        : hour === 12 ? 'del mediodía'
          : hour < 20 ? 'de la tarde'
            : 'de la noche';
  return h === 1 ? `es la una ${period}` : `son las ${h} ${period}`;
}

export default {
  code: 'es',
  tz,
  brand: 'Big Ben',
  booting: 'Arrancando…',

  hourly(brand, at) {
    const { hour, year, progress } = localTime(at, tz);
    return Array(hour % 12 || 12).fill('¡Dong!').join(' ')
      + ` ${brand} les avisa: ${spoken(hour)} en Ciudad de México. Ya se fue el ${percent.format(progress / 100)} de ${year}.`;
  },

  clock(brand, at = now()) {
    // 时间不放句末：a.m. 自带句点，会变成「a.m..」
    const one = mt(at).tz(tz).format('h') === '1';
    return `¡Dong! ${brand} les avisa: en Ciudad de México ${one ? 'es la' : 'son las'} `
      + `${time.format(at.valueOf())} del ${date.format(at.valueOf())}.`;
  },
};
