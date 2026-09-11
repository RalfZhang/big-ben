/**
 * 统一日志：LOG_LEVEL debug < info < warn < error（默认 info）。
 * 所有时间戳统一北京时间，与业务时区一致，方便对着时间线排查。
 */
import mt from 'moment-timezone';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const ts = mt().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
  const line = `${ts} [${level.toUpperCase()}] ${msg}`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra !== undefined) sink(line, extra);
  else sink(line);
}

export const log = {
  debug: (m, e) => emit('debug', m, e),
  info: (m, e) => emit('info', m, e),
  warn: (m, e) => emit('warn', m, e),
  error: (m, e) => emit('error', m, e),
};

// 非 JSON 的响应体（实例/网关抛的 HTML 错误页）：前 200 字符全是 doctype 和 meta，
// 真正有用的是 <title>，优先取它；换行必须压掉，否则一条 ERROR 会炸成十几行日志。
function describeText(raw) {
  const flat = String(raw).replace(/\s+/g, ' ').trim();
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(flat);
  if (title && title[1].trim()) return `HTML "${title[1].trim().slice(0, 120)}"`;
  return flat.slice(0, 200);
}

// 三个平台的错误体格式各不相同，这里统一压成一行：
//   豆瓣     { code, msg | localized_message }
//   长毛象   { error, error_description }
//   Threads  { error: { message, code, type } }
function describeBody(body) {
  if (!body || typeof body !== 'object') return describeText(body);
  if (body.error && typeof body.error === 'object') {
    return JSON.stringify({ code: body.error.code, msg: body.error.message });
  }
  if (body.error !== undefined) {
    return JSON.stringify({ msg: body.error_description || body.error });
  }
  return JSON.stringify({ code: body.code, msg: body.msg || body.localized_message });
}

// 把任意错误（HTTP 错误 / undici 网络错误 / 抛出的对象）压成一行可读文本
export function describeError(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.statusCode) parts.push(`HTTP ${err.statusCode}`);
  if (err.body !== undefined) parts.push(describeBody(err.body));
  // undici 的 "fetch failed" 真正原因都在 err.cause 里（ENOTFOUND/ETIMEDOUT/...）
  if (err.cause) parts.push(`cause=${err.cause.code || err.cause.message || err.cause}`);
  if (!parts.length) parts.push(err.message || String(err));
  return parts.join(' ');
}
