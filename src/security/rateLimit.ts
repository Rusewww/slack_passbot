/**
 * Per-user sliding-window rate limiter.
 *
 * In-memory on purpose: the service is a single small instance, and a shared
 * store would add a dependency holding user identifiers, state we would then
 * have to secure and expire. If this ever scales horizontally, replace
 * the Map with a Redis sorted set behind the same interface.
 */

export class RateLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Records an attempt and reports whether it is allowed. */
  tryConsume(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }

  /** Drops empty buckets so the map cannot grow without bound. */
  sweep(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.#hits) {
      const recent = times.filter((t) => t > cutoff);
      if (recent.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, recent);
    }
  }
}
