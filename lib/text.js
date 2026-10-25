// Time helpers shared by all languages. The post text for each language is in ./locales/.
import mt from 'moment-timezone';

// Logs and daily reply counts use Beijing time. Each account posts in its own locale.tz
export function now() {
  return mt().tz('Asia/Shanghai');
}

export function hourKey(at = now()) {
  return at.format('YYYY-MM-DDTHH');
}

// Mastodon keeps an Idempotency-Key for 1 hour and silently drops a second post with the same key
// (it returns the first post's url, so the log still says OK). So hourly keys are per hour,
// startup keys per minute, and the two must never collide.
// Always Beijing time: it has no DST, so the hour that repeats in London / Paris in autumn
// still gets two different keys
export function idempotencyKey(kind, at = now()) {
  return kind === 'hourly'
    ? `guang-hourly-${hourKey(at)}`
    : `guang-${kind}-${at.format('YYYY-MM-DDTHH:mm')}`;
}

// What the hourly post needs, all in tz: hour (0–23), year, progress, dst.
// mt(at) clones first: .tz() changes in place, and all platforms in a round share one `at`
export function localTime(at, tz) {
  const local = mt(at).tz(tz);

  // Percent of the year passed, counted from New Year in tz
  const yearStart = mt(local).startOf('year');
  const yearEnd = mt(yearStart).add(1, 'year');
  let progress = Math.round(100000 * local.diff(yearStart) / yearEnd.diff(yearStart)) / 1000;
  let year = +local.format('YYYY');
  // At New Year progress is exactly 0. "Last year 100%" reads better than "this year 0%"
  if (progress === 0) {
    year -= 1;
    progress = 100;
  }

  // A different UTC offset than one hour ago means the clocks just changed:
  // 'start' = DST began, 'end' = DST ended, else null. Only the first post after the change
  // sees it. If that post fails it is not resent; not worth storing state for
  const changed = local.utcOffset() !== mt(at).subtract(1, 'hour').tz(tz).utcOffset();
  const dst = !changed ? null : local.isDST() ? 'start' : 'end';

  return { hour: local.hour(), year, progress, dst };
}
