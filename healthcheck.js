// Docker HEALTHCHECK：心跳在 STALE_MS 内更新过则健康。
// index.js 每 10 分钟写一次，超时即判定卡死，交给 restart 策略拉起。
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
