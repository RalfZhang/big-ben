/**
 * Google Gemini。只做一件事：把 { system, user } 送出去，把文本拿回来 ——
 * 人格、时间问句、字数裁剪归 platforms/threads/reply.js 管。
 * 免费档的 RPM/RPD 撞上就是 429，归进「可重试」，watcher 下一轮再来。
 */
import config from '../config.js';
import { log } from '../lib/log.js';

const cfg = (config.ai || {}).gemini || {};

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// 可由 config.ai.gemini.model 覆盖。名字写错的话 Google 回 404，错误里会原样带上
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

// 默认阈值会把带脏话的整条请求拦掉，我们就只能不回复。ONLY_HIGH 只挡真正过分的
const SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

// 别按「只要一两句」抠 maxOutputTokens：新模型的思考 token 也从这个额度扣，
// 给小了会拿到 finishReason=MAX_TOKENS、text 为空的响应
const DEFAULTS = { temperature: 1, maxOutputTokens: 800 };

export default {
  name: 'gemini',
  enabled: Boolean(cfg.enabled && cfg.apiKey),

  async ask({ system, user, generationConfig } = {}) {
    if (!cfg.apiKey) {
      throw new Error('config.ai.gemini.apiKey 是空的 —— 去 https://aistudio.google.com/apikey 申请，免费');
    }

    const model = cfg.model || DEFAULT_MODEL;
    const body = {
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { ...DEFAULTS, ...(cfg.generationConfig || {}), ...(generationConfig || {}) },
      safetySettings: SAFETY,
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const started = Date.now();
    log.debug(`gemini POST ${model}:generateContent`);
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      // key 走 header 不走 query —— query 那份会被中间层记进访问日志
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 20000),
    });

    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    log.debug(`gemini POST ${model}:generateContent -> ${res.status} (${Date.now() - started}ms)`);

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.statusCode = res.status;
      err.body = parsed;
      throw err;
    }

    const cand = parsed?.candidates?.[0];
    const out = (cand?.content?.parts || []).map((p) => p.text).filter(Boolean).join('').trim();
    if (out) return out;

    // HTTP 200 但没文本，成因有好几种，把 Google 给的线索翻成人话带出去
    const blocked = parsed?.promptFeedback?.blockReason;
    const why = blocked ? `对方的原话被安全策略拦了（blockReason=${blocked}）`
      : cand?.finishReason === 'MAX_TOKENS' ? 'maxOutputTokens 太小，思考把额度吃光了（调大或在 generationConfig 里关掉思考）'
        : cand?.finishReason ? `finishReason=${cand.finishReason}`
          : '响应里连 candidates 都没有';
    const err = new Error(`gemini 没给出文本：${why}`);
    err.body = parsed;
    // 请求级：换一条评论就好了，别让 services/ai.js 把整个 provider 静音掉 ——
    // 一句脏话被安全策略拦下，不该连累后面十分钟里所有人的回复
    err.perRequest = true;
    throw err;
  },
};
