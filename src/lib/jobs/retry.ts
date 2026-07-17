/**
 * Retry with exponential backoff and jitter.
 *
 * Bulk work hits rate limits by construction: 1,000 file downloads and hundreds
 * of sheet appends will earn 429s from Google no matter how polite the
 * concurrency cap is. Backoff is what turns those from failures into latency.
 *
 * Jitter matters here specifically because we run N transforms concurrently —
 * without it, a shared 429 syncs every worker onto the same retry schedule and
 * they collide again in lockstep.
 */

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Called before each retry — used for logging, not control flow. */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_MS = 500;
const DEFAULT_MAX_DELAY_MS = 15_000;

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: Error = new Error("retry: never ran");

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    try {
      return await fn();
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === retries || !isRetryable(lastError)) break;

      const backoff = Math.min(baseMs * 2 ** attempt, maxDelayMs);
      const delay = Math.round(backoff / 2 + Math.random() * (backoff / 2));
      opts.onRetry?.(attempt + 1, delay, lastError);
      await sleep(delay, opts.signal);
    }
  }

  throw lastError;
}

/**
 * Retry transport and rate-limit failures; give up immediately on errors that
 * will fail identically next time.
 *
 * Errs toward retrying: a wasted retry costs a second, while wrongly giving up
 * turns a transient blip into a permanent failure row for a real item.
 */
export function isRetryable(error: Error): boolean {
  const message = `${error.message} ${String((error as any).cause ?? "")}`.toLowerCase();

  // Unambiguously permanent: the same request will fail the same way.
  if (/\b(not found|404|unauthorized|401|forbidden|403|invalid[_ ]grant)\b/.test(message)) {
    return false;
  }
  return true;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}
