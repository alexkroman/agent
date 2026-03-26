// Copyright 2025 the AAI authors. MIT license.

/**
 * In-memory sliding-window rate limiter.
 *
 * Each key (e.g. API-key hash or IP address) gets a separate window.
 * Expired entries are lazily pruned on each `consume()` call and periodically
 * via a background sweep to prevent memory leaks from abandoned keys.
 */

export type RateLimitConfig = {
  /** Maximum number of requests allowed within the window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
};

type Window = {
  /** Timestamps of requests within the current window. */
  timestamps: number[];
};

export class RateLimiter {
  readonly #config: RateLimitConfig;
  readonly #windows = new Map<string, Window>();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: RateLimitConfig) {
    this.#config = config;
    // Sweep stale entries every 60 s to bound memory.
    this.#sweepTimer = setInterval(() => this.#sweep(), 60_000);
    // Allow the process to exit without waiting for the timer.
    if (typeof this.#sweepTimer === "object" && "unref" in this.#sweepTimer) {
      this.#sweepTimer.unref();
    }
  }

  /**
   * Try to consume one request for `key`.
   * Returns `true` if the request is allowed, `false` if rate-limited.
   */
  consume(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.#config.windowMs;

    let win = this.#windows.get(key);
    if (!win) {
      win = { timestamps: [] };
      this.#windows.set(key, win);
    }

    // Remove expired timestamps
    win.timestamps = win.timestamps.filter((t) => t > cutoff);

    if (win.timestamps.length >= this.#config.maxRequests) {
      return false;
    }

    win.timestamps.push(now);
    return true;
  }

  /** Remove all entries. Useful in tests. */
  reset(): void {
    this.#windows.clear();
  }

  /** Stop the background sweep timer. */
  dispose(): void {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
  }

  #sweep(): void {
    const cutoff = Date.now() - this.#config.windowMs;
    for (const [key, win] of this.#windows) {
      win.timestamps = win.timestamps.filter((t) => t > cutoff);
      if (win.timestamps.length === 0) {
        this.#windows.delete(key);
      }
    }
  }
}

/**
 * Tracks concurrent connections per key and enforces a maximum.
 */
export class ConnectionLimiter {
  readonly #maxPerKey: number;
  readonly #counts = new Map<string, number>();

  constructor(maxPerKey: number) {
    this.#maxPerKey = maxPerKey;
  }

  /** Try to acquire a connection slot. Returns `true` if allowed. */
  acquire(key: string): boolean {
    const current = this.#counts.get(key) ?? 0;
    if (current >= this.#maxPerKey) {
      return false;
    }
    this.#counts.set(key, current + 1);
    return true;
  }

  /** Release a connection slot. */
  release(key: string): void {
    const current = this.#counts.get(key) ?? 0;
    if (current <= 1) {
      this.#counts.delete(key);
    } else {
      this.#counts.set(key, current - 1);
    }
  }

  /** Current count for a key. */
  count(key: string): number {
    return this.#counts.get(key) ?? 0;
  }

  /** Remove all entries. Useful in tests. */
  reset(): void {
    this.#counts.clear();
  }
}
