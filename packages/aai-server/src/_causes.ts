// Copyright 2026 the AAI authors. MIT license.

import { isRecord } from "@alexkroman1/aai/utils";

/**
 * `err` and every record in its `cause` chain, outermost first.
 *
 * Stops at the first link that is not a record, and at the first one already
 * seen: a `cause` chain is not required to be acyclic.
 */
export function* causes(err: unknown): Generator<Record<string, unknown>, void, undefined> {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (isRecord(cur) && !seen.has(cur)) {
    seen.add(cur);
    yield cur;
    cur = cur.cause;
  }
}
