import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucket } from "../rate-limiter";

describe("TokenBucket", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lets a burst through at once, then spaces starts at the refill rate", async () => {
    const bucket = new TokenBucket(25, 25);
    const started: number[] = [];
    const t0 = Date.now();
    const all = Array.from({ length: 30 }, () => bucket.acquire().then(() => started.push(Date.now() - t0)));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(25);
    await vi.advanceTimersByTimeAsync(250);
    await Promise.all(all);
    expect(started).toHaveLength(30);
    expect(started.at(-1)).toBeGreaterThanOrEqual(190);
    expect(started.at(-1)).toBeLessThanOrEqual(250);
  });

  it("serves waiters in order", async () => {
    const bucket = new TokenBucket(10, 1);
    const order: number[] = [];
    const all = [1, 2, 3].map((n) => bucket.acquire().then(() => order.push(n)));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(all);
    expect(order).toEqual([1, 2, 3]);
  });

  it("drops an aborted waiter from the queue", async () => {
    const bucket = new TokenBucket(1, 1);
    await bucket.acquire();
    const ctrl = new AbortController();
    const waiting = bucket.acquire(ctrl.signal);
    expect(bucket.waiting).toBe(1);
    ctrl.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    expect(bucket.waiting).toBe(0);
  });

  it("holds every start while paused", async () => {
    const bucket = new TokenBucket(100, 100);
    bucket.pause(1000);
    let started = false;
    const p = bucket.acquire().then(() => (started = true));
    await vi.advanceTimersByTimeAsync(900);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(started).toBe(true);
  });
});
