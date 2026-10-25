/**
 * Shared record of comments already replied to. A comment under our post that also @mentions us
 * shows up in both /mentions and /conversation; without this, each watcher would reply once.
 * Losing the file means at worst a few duplicate replies, so writes are not atomic.
 */
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../../lib/log.js';

export const REPLIED_FILE = process.env.THREADS_REPLIED_FILE
  || new URL('../../data/threads-replied.json', import.meta.url).pathname;

// Both watchers look back only minutes; 500 is plenty
const MAX = 500;

let ids = null;   // memory is the source of truth; the file only survives restarts

function load() {
  if (ids) return ids;
  try {
    const raw = JSON.parse(fs.readFileSync(REPLIED_FILE, 'utf8'));
    ids = new Set(Array.isArray(raw) ? raw : raw.ids || []);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`${REPLIED_FILE} unreadable, starting empty: ${err.message}`);
    ids = new Set();
  }
  return ids;
}

function save() {
  // Sets keep insertion order, so the last MAX are the newest
  const keep = [...ids].slice(-MAX);
  ids = new Set(keep);
  try {
    fs.mkdirSync(path.dirname(REPLIED_FILE), { recursive: true });
    fs.writeFileSync(REPLIED_FILE, `${JSON.stringify(keep)}\n`);
  } catch (err) {
    // Only affects dedup across restarts; don't fail the reply for it
    log.warn(`${REPLIED_FILE} write failed: ${err.message}`);
  }
}

export function hasReplied(id) {
  return load().has(String(id));
}

export function markReplied(id) {
  load().add(String(id));
  save();
}
