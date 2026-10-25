// French: Paris time, 24-hour clock (15 h is common in speech and writing),
// but only 1–12 strikes, like French church bells.
// French puts a space before ! ? and :. Use no-break spaces so the mark never wraps alone:
// narrow before ! ?, normal before :.
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

  // No verb: in "81 % de 2026 s'est envolé" the verb agreement changes for 1–2 %
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
