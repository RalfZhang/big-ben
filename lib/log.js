// Logging. LOG_LEVEL: debug < info < warn < error (default info). Timestamps in Beijing time.
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

// Gateway HTML error pages: the first 200 chars are doctype; <title> has the useful part.
// Collapse newlines, or one ERROR becomes a dozen lines
function describeText(raw) {
  const flat = String(raw).replace(/\s+/g, ' ').trim();
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(flat);
  if (title && title[1].trim()) return `HTML "${title[1].trim().slice(0, 120)}"`;
  return flat.slice(0, 200);
}

// Each platform has its own error body:
//   Douban    { code, msg | localized_message }
//   Mastodon  { error, error_description }
//   Threads   { error: { message, code, type } }
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

// Turn any error into one readable line
export function describeError(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.statusCode) parts.push(`HTTP ${err.statusCode}`);
  if (err.body !== undefined) parts.push(describeBody(err.body));
  // For undici's "fetch failed", the real reason is in err.cause
  if (err.cause) parts.push(`cause=${err.cause.code || err.cause.message || err.cause}`);
  if (!parts.length) parts.push(err.message || String(err));
  return parts.join(' ');
}
