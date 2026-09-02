// Copyright 2026 the AAI authors. MIT license.
/**
 * `nextEventIndex`'s READ of the driver's answer, in the unit tier.
 *
 * Every other spec over this store either needs a real Postgres
 * (`platform-session-state.scenario.test.ts`,
 * `session-state-conformance-platform.scenario.test.ts`) or answers through a
 * fake that hands back a JS number by construction
 * (`session-state-handler.test.ts`). Neither can state the two facts below
 * where a developer with no database will see them, and both are facts about
 * the DECODE rather than about the SQL — so a fake `SqlExec` is the honest
 * arm for them.
 *
 * - **`event_index` is a `bigint`, and postgres.js hands `int8` back as a
 *   STRING.** The `Number(...)` in `nextEventIndex` is therefore load-bearing,
 *   and it is invisible to every arm except the real-Postgres one — removing it
 *   reddens six conformance cases there and nothing anywhere else. Which is
 *   exactly the shape of a conversion somebody "cleans up".
 * - **An answer this code cannot read THROWS, and never defaults to 0.** `0`
 *   means "this session has no events", so guessing it hands a resumed session
 *   an index it has already used and its appends overwrite history from the
 *   start. The runtime's client refuses the same value for the same reason
 *   (`aai-runtime/session-state-platform.ts`); this end used to do the
 *   opposite.
 */

import { describe, expect, test } from "vitest";
import { nextEventIndex } from "./platform-session-state.ts";
import { createRecordingSql } from "./test-utils.ts";

/** A driver answering one row's `next`, as postgres.js would shape it. */
const answering = (next: unknown) => createRecordingSql(() => [{ next }]).sql;

const SLUG = "an-agent";
const SESSION = "sess_1";

describe("nextEventIndex reads the driver's answer", () => {
  test("a bigint arriving as a STRING is read as a number", async () => {
    // The whole reason `Number(...)` is in that function. `coalesce(max(...),
    // -1) + 1` over a `bigint` column is `bigint` arithmetic, and postgres.js
    // returns `int8` as a string — so without the conversion the route answers
    // `"6"`, the guest's client refuses a non-number, and every hydrate on a
    // deployed agent fails. Asserted with `toBe` so a string 6 cannot pass.
    await expect(nextEventIndex(answering("6"), SLUG, SESSION)).resolves.toBe(6);
  });

  test("an empty log's zero is answered, not refused", async () => {
    // The common case, and the one that makes the refusal below a real
    // distinction rather than a blanket "0 is suspicious": a fresh session
    // legitimately reads 0, every hydrate does it, and it arrives as `"0"`.
    await expect(nextEventIndex(answering("0"), SLUG, SESSION)).resolves.toBe(0);
  });

  test.each([
    // `Number(null)` is 0 — the coercion trap that made the old `: 0` fallback
    // look harmless. A NULL column answered the ONE value that must never be
    // guessed, and did it through the integer check rather than around it.
    ["a NULL column", null],
    ["a value that is not a number at all", "not an index"],
    ["a negative index", "-1"],
  ])("refuses %s rather than answering 0", async (_label, next) => {
    await expect(nextEventIndex(answering(next), SLUG, SESSION)).rejects.toThrow(/non-index/);
  });

  test("refuses a statement that answered NO ROW", async () => {
    // Unreachable on a healthy request — an aggregate with no `group by`
    // returns exactly one row — which is what makes the throw safe: it cannot
    // 503 a working session. It is still a refusal rather than a 0, because
    // "the read did not happen" and "there are no events" are different
    // answers and only one of them is safe to act on.
    const { sql } = createRecordingSql(() => []);
    await expect(nextEventIndex(sql, SLUG, SESSION)).rejects.toThrow(/non-index/);
  });

  test("the refusal names the value and NOT the sessionId", async () => {
    // The message reaches a warn line through `withReserved`, and the slug is
    // already in that call's `detail`. A caller-supplied sessionId in a log
    // message is the caller's to shape; the driver's answer is not.
    await expect(nextEventIndex(answering("nope"), SLUG, SESSION)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(SESSION) }),
    );
  });

  test("the slug and session id are BOUND, never interpolated", async () => {
    const { sql, calls } = createRecordingSql(() => [{ next: "3" }]);
    await nextEventIndex(sql, SLUG, SESSION);
    expect(calls[0]?.params).toEqual([SLUG, SESSION]);
    expect(calls[0]?.query).not.toContain(SLUG);
  });
});
