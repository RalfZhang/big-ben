export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 只重试可能自愈的错：5xx、429、undici 网络层错误（原因在 err.cause）。
// 4xx 是请求本身的问题，重试只是白烧一个整点。
export function isRetryable(err) {
  if (!err) return false;
  if (err.statusCode) return err.statusCode >= 500 || err.statusCode === 429;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return Boolean(err.cause);
}
