export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry only errors that may fix themselves: 5xx, 429, network errors (undici puts them in err.cause).
// A 4xx means the request itself is wrong.
export function isRetryable(err) {
  if (!err) return false;
  if (err.statusCode) return err.statusCode >= 500 || err.statusCode === 429;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return Boolean(err.cause);
}
