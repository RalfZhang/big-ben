// Heartbeat file. healthcheck.js reads it to check that the process is alive.
import fs from 'node:fs';
import { log } from './log.js';

export const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/big-ben.heartbeat';

export function beat() {
  try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); }
  catch (err) { log.warn(`heartbeat write failed: ${err.message}`); }
}
