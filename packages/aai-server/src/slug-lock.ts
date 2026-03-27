// Copyright 2025 the AAI authors. MIT license.

/**
 * Per-slug mutex that serializes deploy and delete operations for the same
 * agent, preventing race conditions where a concurrent delete corrupts
 * in-flight deploy state (or vice-versa).
 */
const slugLocks = new Map<string, Promise<Response>>();

export function withSlugLock(slug: string, fn: () => Promise<Response>): Promise<Response> {
  const existing = slugLocks.get(slug);

  const run = async (): Promise<Response> => {
    if (existing) {
      await existing.catch(() => {
        /* previous operation finished or failed — safe to proceed */
      });
    }
    return fn();
  };

  const p = run();
  slugLocks.set(slug, p);

  const cleanup = () => {
    // Only delete if we're still the current lock holder.
    if (slugLocks.get(slug) === p) slugLocks.delete(slug);
  };

  return p.then(
    (res) => {
      cleanup();
      return res;
    },
    (err) => {
      cleanup();
      throw err;
    },
  );
}
