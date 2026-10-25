// 法语：巴黎时间，24 小时制（法语圈书面和口语都常用：15 h），
// 但跟法国教堂的钟一样只敲 1–12 下。
// 法语排版 ! ? 前空一格，用窄不换行空格，免得标点被挤到下一行；: 前用普通不换行空格
import mt from 'moment-timezone';

import { localTime, now } from '../text.js';

const tz = 'Europe/Paris';
const NNBSP = ' ';
const NBSP = ' ';
const percent = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 3 });
const date = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, dateStyle: 'full' });

const DST = {
  start: `C'est le passage à l'heure d'été${NBSP}: avez-vous avancé vos montres${NNBSP}?`,
  end: `C'est le passage à l'heure d'hiver${NBSP}: avez-vous reculé vos montres${NNBSP}?`,
};

function spoken(hour) {
  if (hour === 0) return 'minuit';
  if (hour === 12) return 'midi';
  return `${hour}${NBSP}h`;
}

export default {
  code: 'fr',
  tz,
  brand: 'Big Ben',
  booting: 'Démarrage…',

  // 「81 % de 2026 s'est envolé」的动词配合在 1 % ~ 2 % 时要变，所以用不带动词的句子
  hourly(brand, at) {
    const { hour, year, progress, dst } = localTime(at, tz);
    return Array(hour % 12 || 12).fill(`Dong${NNBSP}!`).join(' ')
      + ` Ici ${brand}${NBSP}: il est ${spoken(hour)} à Paris. Déjà ${percent.format(progress / 100)} de l'année ${year} derrière nous.`
      + (dst ? ` ${DST[dst]}` : '');
  },

  clock(brand, at = now()) {
    return `Dong${NNBSP}! Ici ${brand}${NBSP}: il est ${mt(at).tz(tz).format('HH:mm:ss')} à Paris, ${date.format(at.valueOf())}.`;
  },
};
