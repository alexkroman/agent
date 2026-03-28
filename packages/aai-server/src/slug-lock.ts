// Copyright 2025 the AAI authors. MIT license.

/**
 * Per-slug mutex that serializes deploy and delete operations for the same
 * agent, preventing race conditions where a concurrent delete corrupts
 * in-flight deploy state (or vice-versa).
 */
import AsyncLock from "async-lock";

const lock = new AsyncLock();

export const withSlugLock = (slug: string, fn: () => Promise<Response>): Promise<Response> =>
  lock.acquire(slug, fn);
