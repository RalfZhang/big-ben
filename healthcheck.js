/**
 * Docker HEALTHCHECK：心跳文件在 STALE_MS 内更新过则视为健康。
 * index.js 启动时和每 10 分钟唤醒时各写一次心跳，
 * 这里给到 15 分钟容差，超时即判定进程卡死，由 restart 策略拉起。
 */
import fs from 'node:fs';

const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/big-ben.heartbeat';
const STALE_MS = 15 * 60 * 1000;

try {
  const ts = Number(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
  const age = Date.now() - ts;
  if (!Number.isFinite(ts) || age > STALE_MS) {
    console.error(`unhealthy: heartbeat is ${Math.round(age / 1000)}s old`);
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error(`unhealthy: cannot read heartbeat (${err.message})`);
  process.exit(1);
}
