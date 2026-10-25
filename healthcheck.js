// Docker HEALTHCHECK: healthy if the heartbeat is newer than STALE_MS.
// index.js writes it every 10 minutes.
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
