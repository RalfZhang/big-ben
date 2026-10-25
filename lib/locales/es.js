// Spanish: Mexico City time (largest Spanish-speaking country, no DST since 2022).
// 12-hour clock plus time of day ("las 3 de la tarde", used in Spain and Latin America), 1–12 strikes.
// Mexican number style: decimal point, no space before %.
import mt from 'moment-timezone';

import { localTime, now } from '../text.js';

const tz = 'America/Mexico_City';
const percent = new Intl.NumberFormat('es-MX', { style: 'percent', maximumFractionDigits: 3 });
const date = new Intl.DateTimeFormat('es-MX', { timeZone: tz, dateStyle: 'full' });
const time = new Intl.DateTimeFormat('es-MX', { timeZone: tz, timeStyle: 'medium' });

// 1 o'clock is singular: es la una
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
    // Don't end with the time: "a.m." already has a dot, giving "a.m.."
    const one = mt(at).tz(tz).format('h') === '1';
    return `¡Dong! ${brand} les avisa: en Ciudad de México ${one ? 'es la' : 'son las'} `
      + `${time.format(at.valueOf())} del ${date.format(at.valueOf())}.`;
  },
};
