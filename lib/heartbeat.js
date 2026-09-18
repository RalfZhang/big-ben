// 心跳文件：healthcheck.js 读它判断进程是否还活着。
import fs from 'node:fs';
import { log } from './log.js';

export const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/big-ben.heartbeat';

export function beat() {
  try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); }
  catch (err) { log.warn(`heartbeat write failed: ${err.message}`); }
}
