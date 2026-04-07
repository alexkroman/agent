// Copyright 2025 the AAI authors. MIT license.

export type ConnectionTracker = {
  /** Try to acquire a connection slot. Returns false if at capacity. */
  tryAcquire(): boolean;
  /** Release a connection slot. */
  release(): void;
  /** Current active connection count. */
  readonly count: number;
};

export function createConnectionTracker(max: number): ConnectionTracker {
  let count = 0;
  return {
    tryAcquire() {
      if (count >= max) return false;
      count++;
      return true;
    },
    release() {
      if (count > 0) count--;
    },
    get count() {
      return count;
    },
  };
}
