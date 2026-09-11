/**
 * 报时文案。各平台只有品牌名不同，其余逐字一致。
 */
import mt from 'moment-timezone';

export function now() {
  return mt().tz('Asia/Shanghai');
}

// 长毛象 Idempotency-Key 用：同一整点内重试不会重复发嘟
export function hourKey(at = now()) {
  return at.format('YYYY-MM-DDTHH');
}

// 长毛象的 Idempotency-Key：服务端缓存 1 小时，同一个 key 的第二条会被直接去重，
// 返回的还是第一条的 url —— 日志照样打 OK，人却发现嘟没出去。
// 所以整点报时和启动播报是两种内容，必须用两种 key：整点按小时（同一整点内重试不重复发），
// 启动播报按分钟（崩溃重启循环里不至于刷屏，也不会去撞整点那条）。
export function idempotencyKey(kind, at = now()) {
  return kind === 'hourly'
    ? `guang-hourly-${hourKey(at)}`
    : `guang-${kind}-${at.format('YYYY-MM-DDTHH:mm')}`;
}

export function getText(brand, at = now()) {
  const yearStart = mt(at).startOf('year');
  const yearEnd = mt(yearStart).add(1, 'year');
  let progress = Math.round(100000 * at.diff(yearStart) / yearEnd.diff(yearStart)) / 1000;
  let hour = +at.format('HH');
  if (hour === 0) hour = 24;
  let year = at.format('YYYY');
  // 跨年瞬间 progress 正好是 0，报「去年 100%」比「今年 0%」更合直觉
  if (progress === 0) {
    year = year - 1;
    progress = 100;
  }
  return '咣！'.repeat(hour) + `${brand}大笨钟提醒您：北京时间 ${hour} 点整，${year} 年已悄悄溜走 ${progress}%。`;
}
