/**
 * Token bucket that gates when a request may START. A started stream runs as long as it needs,
 * so with 25 starts/s, 25 characters stream at once and the 26th waits ~40 ms, not a whole reply.
 * Waiters are served FIFO; an aborted waiter leaves the line.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private pausedUntil = 0;
  private queue: { resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Resolves when a request may start. Rejects with the signal's reason if aborted while waiting. */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.queue)[number] = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.queue = this.queue.filter((w) => w !== waiter);
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.drain();
    });
  }

  /** Stop all starts for `ms` (a 429 means the next requests would hit the same wall). */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
    this.tokens = 0;
    this.schedule();
  }

  get waiting(): number {
    return this.queue.length;
  }

  private refill(): void {
    const t = this.now();
    if (t < this.pausedUntil) {
      this.last = t;
      return;
    }
    const from = Math.max(this.last, this.pausedUntil);
    this.tokens = Math.min(this.burst, this.tokens + ((t - from) / 1000) * this.perSecond);
    this.last = t;
  }

  private drain(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      const waiter = this.queue.shift()!;
      this.tokens -= 1;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return;
    const t = this.now();
    const wait = t < this.pausedUntil ? this.pausedUntil - t : ((1 - this.tokens) / this.perSecond) * 1000;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, Math.max(1, Math.ceil(wait)));
  }
}

const buckets = new Map<string, TokenBucket>();

/** One bucket per provider for this process. Multi-instance deploys (Vercel) would need a shared store. */
export function bucketFor(providerId: string, limit: { perSecond: number; burst: number }): TokenBucket {
  let bucket = buckets.get(providerId);
  if (!bucket) {
    bucket = new TokenBucket(limit.perSecond, limit.burst);
    buckets.set(providerId, bucket);
  }
  return bucket;
}
