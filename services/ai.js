/**
 * AI 回复服务的门面。加第二家：照 gemini.js 的形状写一个模块 ——
 *   { name, enabled, ask({ system, user, generationConfig }) -> string }
 * 塞进 PROVIDERS，数组顺序就是兜底顺序。
 */
import { log, describeError } from '../lib/log.js';
import { isRetryable } from '../lib/retry.js';
import gemini from './gemini.js';

const PROVIDERS = [gemini];

// 不可重试的错（key 打错、模型名不存在）不会自己好，而调用方是每分钟一轮的 watcher，
// 不静音就是一天几千行同样的错。到期自动再试一次，免得永久瘫掉
const MUTE_MS = 10 * 60 * 1000;
const mutedUntil = new Map();

export function aiProviders() {
  return PROVIDERS.filter((p) => p.enabled).map((p) => p.name);
}

// 按顺序问，谁先给出文本就用谁的。这里不重试：调用方自己有失败计数和退避，
// 两层叠起来会把一条评论试上十几次
export async function ask(req) {
  const usable = PROVIDERS.filter((p) => p.enabled);
  if (!usable.length) {
    const err = new Error('没有可用的 AI provider（检查 config.ai.gemini 的 enabled 和 apiKey）');
    err.noProvider = true;
    throw err;
  }

  let lastErr;
  for (const p of usable) {
    const muted = mutedUntil.get(p.name) || 0;
    if (Date.now() < muted) {
      log.debug(`ai: ${p.name} 还在静音里，${Math.round((muted - Date.now()) / 1000)}s 后再试`);
      continue;
    }

    const started = Date.now();
    try {
      const text = await p.ask(req);
      mutedUntil.delete(p.name);
      log.debug(`ai: ${p.name} OK (${Date.now() - started}ms, ${text.length} 字)`);
      return { text, provider: p.name };
    } catch (err) {
      lastErr = err;
      if (isRetryable(err)) {
        // 429（免费档每分钟上限）和 5xx 下一轮多半就好了，不值得静音
        log.warn(`ai: ${p.name} 失败（可重试）：${describeError(err)}`);
      } else if (err.perRequest) {
        // 这一条内容本身的问题（被安全策略拦、没给出文本），换条评论就好了。
        // 静音是留给「换谁问都一样」的故障的，别把它跟这个混为一谈。
        // 这里打 message 不打 describeError：原因写在 message 里，而 err.body 是
        // Gemini 的原始响应，没有 code/msg，describeBody 只会挤出一个 {}。
        // 不再补 p.name —— 约定 perRequest 的 message 自带 provider 名（见 gemini.js）
        log.warn(`ai: ${err.message}`);
      } else {
        mutedUntil.set(p.name, Date.now() + MUTE_MS);
        log.error(`ai: ${p.name} 失败，静音 ${MUTE_MS / 60000} 分钟：${describeError(err)}`);
      }
    }
  }

  // 全员静音：lastErr 是 undefined（一次请求都没发出去）。这跟「发了但失败了」不一样，
  // 调用方要靠 noProvider 认出来 —— 不该算成这条评论自己的失败
  if (lastErr) throw lastErr;
  const err = new Error('所有 AI provider 都在静音里');
  err.noProvider = true;
  throw err;
}
