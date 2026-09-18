/**
 * 共享的回复配额闸门 —— 两个 watcher 花的是同一个池子（API 回复 1000 条/24h 滑动窗口），
 * 各记各的日计数就会算出 200 + 900 这种超额，所以直接问服务端的真实用量。
 * 顺带解决三件事：重启后计数不清零、滑动窗口跟自然日对不上、手动在 App 里回的也算进去。
 *
 * 整点敲钟不花这个池子 —— 发帖是另一档 250 条/24h。
 */
import config from '../../config.js';
import { log, describeError } from '../../lib/log.js';
import { graph, owner } from './index.js';

const cfg = config.threads || {};

// 查不到 reply_config 时的兜底值，也就是文档写的那个数
const FALLBACK_TOTAL = 1000;

const headroom = Math.max(0, Number(cfg.replyQuotaHeadroom ?? 100));

// 每条回复前都问一次太浪费，缓存一分钟；缓存期内发出去的用 spent 自己扣，不会超发
const CACHE_MS = 60 * 1000;

let cache = { at: 0, left: null };
let spent = 0;
let warned = false;

// 还能再回几条。null = 问不出来，调用方退回自己的 dailyCap ——
// 宁可 null 也不返回 0，这个 edge 抽风不该让整个功能停摆
export async function replyBudgetLeft() {
  if (cache.left !== null && Date.now() - cache.at < CACHE_MS) {
    return Math.max(0, cache.left - spent);
  }

  try {
    const body = await graph(`/${owner}/threads_publishing_limit`, {
      form: { fields: 'reply_quota_usage,reply_config' },
    });
    // 这个 edge 返回 { data: [ {...} ] }，但真给成裸对象也接着
    const row = (Array.isArray(body?.data) ? body.data[0] : body) || {};
    const total = Number(row.reply_config?.quota_total) || FALLBACK_TOTAL;
    const used = Number(row.reply_quota_usage) || 0;

    cache = { at: Date.now(), left: Math.max(0, total - headroom - used) };
    spent = 0;
    warned = false;
    log.debug(`threads reply quota: 已用 ${used}/${total}，预留 ${headroom}，还能回 ${cache.left} 条`);
    return cache.left;
  } catch (err) {
    // 每分钟一条 WARN 也是刷屏，只在状态变化时说一次
    if (!warned) {
      log.warn(`threads_publishing_limit 查不到，回复配额改由各自的 dailyCap 兜着：${describeError(err)}`);
      warned = true;
    }
    cache = { at: Date.now(), left: null };
    return null;
  }
}

// 发出去一条就喊一声，让缓存期内的判断跟着往下走
export function spendReplyBudget(n = 1) {
  spent += n;
}
