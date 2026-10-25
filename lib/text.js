// 跨语言共用的时间工具。各语言的报时文案在 ./locales/ 里。
import mt from 'moment-timezone';

// 日志、自动回复的日计数都按北京时间。各账号报时用哪个时区看它的 locale.tz
export function now() {
  return mt().tz('Asia/Shanghai');
}

export function hourKey(at = now()) {
  return at.format('YYYY-MM-DDTHH');
}

// 长毛象的 Idempotency-Key 服务端缓存 1 小时，同 key 的第二条会被静默去重（返回第一条的 url，
// 日志照样打 OK）。所以整点报时按小时、启动播报按分钟，两者不能撞。
// 一律用北京时间算：北京没有夏令时，伦敦 / 巴黎秋天重复的那个钟点在这里是两个不同的 key
export function idempotencyKey(kind, at = now()) {
  return kind === 'hourly'
    ? `guang-hourly-${hourKey(at)}`
    : `guang-${kind}-${at.format('YYYY-MM-DDTHH:mm')}`;
}

// 整点报时要用的几样，都按 tz 那边算：hour（0–23）、year、progress、dst。
// mt(at) 先克隆 —— .tz() 会原地改，而 at 是一轮里各平台共用的那一个
export function localTime(at, tz) {
  const local = mt(at).tz(tz);

  // 今年已经过去百分之几，按 tz 那边的元旦算
  const yearStart = mt(local).startOf('year');
  const yearEnd = mt(yearStart).add(1, 'year');
  let progress = Math.round(100000 * local.diff(yearStart) / yearEnd.diff(yearStart)) / 1000;
  let year = +local.format('YYYY');
  // 跨年瞬间 progress 正好是 0，报「去年 100%」比「今年 0%」更合直觉
  if (progress === 0) {
    year -= 1;
    progress = 100;
  }

  // 跟一小时前比 UTC 偏移，变了就是刚拨过钟：'start' 进夏令时，'end' 出夏令时，否则 null。
  // 只有拨钟后的第一条整点报时会撞上；那条没发出去也不补，不值得为它存状态
  const changed = local.utcOffset() !== mt(at).subtract(1, 'hour').tz(tz).utcOffset();
  const dst = !changed ? null : local.isDST() ? 'start' : 'end';

  return { hour: local.hour(), year, progress, dst };
}
