/**
 * 共享的「已经回过哪条」账本。一条既 @ 我又发在我帖子底下的评论，
 * /mentions 和 /conversation 会各返回一次，两个 watcher 各记各的就会各回一条。
 * 文件丢了最坏重复回几条，所以不做原子写。
 */
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../../lib/log.js';

export const REPLIED_FILE = process.env.THREADS_REPLIED_FILE
  || new URL('../../data/threads-replied.json', import.meta.url).pathname;

// 两个 watcher 的回溯窗口都是分钟级，500 条足够盖住
const MAX = 500;

let ids = null;   // 进程内为准，文件只是为了跨重启

function load() {
  if (ids) return ids;
  try {
    const raw = JSON.parse(fs.readFileSync(REPLIED_FILE, 'utf8'));
    ids = new Set(Array.isArray(raw) ? raw : raw.ids || []);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`${REPLIED_FILE} 读不出来，当成空账本：${err.message}`);
    ids = new Set();
  }
  return ids;
}

function save() {
  // Set 迭代即插入顺序，取后 MAX 个就是最近的
  const keep = [...ids].slice(-MAX);
  ids = new Set(keep);
  try {
    fs.mkdirSync(path.dirname(REPLIED_FILE), { recursive: true });
    fs.writeFileSync(REPLIED_FILE, `${JSON.stringify(keep)}\n`);
  } catch (err) {
    // 写不进去只影响跨重启判重，不值得让这条回复失败
    log.warn(`${REPLIED_FILE} 写不进去：${err.message}`);
  }
}

export function hasReplied(id) {
  return load().has(String(id));
}

export function markReplied(id) {
  load().add(String(id));
  save();
}
