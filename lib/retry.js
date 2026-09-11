/**
 * 三个平台共用的退避重试策略。
 */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 只重试「再试一次可能就好了」的错误：5xx（实例/网关抽风）、429（限流）、
// 以及 undici 的网络层错误（ENOTFOUND / ETIMEDOUT，真正原因在 err.cause 里）。
// 4xx 是请求本身有问题，重试只是把一个整点白白烧掉。
export function isRetryable(err) {
  if (!err) return false;
  if (err.statusCode) return err.statusCode >= 500 || err.statusCode === 429;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return Boolean(err.cause);
}
