/**
 * 各语言的报时文案。加一种语言：照 en.js 的形状写一个模块塞进 LOCALES ——
 *   { code, tz, brand?, booting, hourly(brand, at), clock(brand, at) }
 * code 同时是 config 里 accounts 的 key（threads.accounts.en）和长毛象发嘟的 language。
 * 没有 brand 的（中文）由各平台 adapter 给自己的品牌名。
 */
import en from './en.js';
import es from './es.js';
import fr from './fr.js';
import zh from './zh.js';

const LOCALES = { zh, en, es, fr };

export function getLocale(code) {
  const locale = LOCALES[code];
  if (!locale) throw new Error(`不认识的语言「${code}」，可选：${Object.keys(LOCALES).join(' / ')}`);
  return locale;
}
