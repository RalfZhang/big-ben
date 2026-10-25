/**
 * Post text for each language. To add one, write a module like en.js and add it to LOCALES:
 *   { code, tz, brand?, booting, hourly(brand, at), clock(brand, at) }
 * code is also the accounts key in config (threads.accounts.en) and the Mastodon post language.
 * zh has no brand: each platform adapter gives its own.
 */
import en from './en.js';
import es from './es.js';
import fr from './fr.js';
import zh from './zh.js';

const LOCALES = { zh, en, es, fr };

export function getLocale(code) {
  const locale = LOCALES[code];
  if (!locale) throw new Error(`Unknown language "${code}". Options: ${Object.keys(LOCALES).join(' / ')}`);
  return locale;
}
