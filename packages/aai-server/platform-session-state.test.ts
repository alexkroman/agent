// Copyright 2026 the AAI authors. MIT license.
/**
 * How this store READS the driver's answer, in the unit tier.
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
 *   STRING.** The read in `nextEventIndex` and `readEvents` is therefore
 *   load-bearing, and it is invisible to every arm except the real-Postgres one
 *   — removing it reddens six conformance cases there and nothing anywhere
 *   else. Which is exactly the shape of a conversion somebody "cleans up".
 * - **An answer this code cannot read THROWS.** `nextEventIndex` never defaults
 *   to 0: `0` means "this session has no events", so guessing it hands a
 *   resumed session an index it has already used and its appends overwrite
 *   history from the start. `readEvents` never skips a row: a page is a cursor
 *   read, so a skipped row is an event silently gone from the stream. The
 *   runtime's client refuses both for the same reasons
 *   (`aai-runtime/session-state-platform.ts`); this end used to do the opposite
 *   on both counts.
 */

import { describe, expect, test } from "vitest";
import { nextEventIndex, readEvents } from "./platform-session-state.ts";
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

/** A driver answering the given `session_events` rows, as postgres.js shapes them. */
const rowsOf = (...rows: Record<string, unknown>[]) => createRecordingSql(() => rows).sql;

/** A healthy page at the given indices — `bigint` columns, so every one a string. */
const rowsAt = (...indices: string[]) =>
  readEvents(
    rowsOf(...indices.map((event_index) => ({ event_index, event: '{"t":"a"}' }))),
    SLUG,
    SESSION,
    0,
    10,
  );

/**
 * `readEvents` refuses a row it cannot read, and does NOT leave a hole.
 *
 * The same class as the refusal above and one step less obvious, which is why it
 * outlived it: a page is a CURSOR read, so a skipped row is not a degraded answer
 * but an event silently gone from the stream — the page it was dropped from is
 * indistinguishable from a page that never held it. The `flatMap` that used to be
 * here also had the coercion trap in its worse form, so the NULL case below is the
 * one that mattered: `Number(null)` is `0`, which passes `Number.isInteger`, so
 * that row was EMITTED at index 0 rather than dropped, displacing the session's
 * real first event in every reader's page.
 */
describe("readEvents reads the driver's rows", () => {
  test("a page of bigint indices arriving as STRINGS is read as numbers", async () => {
    // The healthy path, and the whole reason a read is needed at all: `event_index`
    // is a `bigint`, so postgres.js hands every one of these back as a string.
    await expect(rowsAt("0", "1", "7")).resolves.toEqual([
      { index: 0, event: '{"t":"a"}' },
      { index: 1, event: '{"t":"a"}' },
      { index: 7, event: '{"t":"a"}' },
    ]);
  });

  test("an empty log is an empty page, not a refusal", async () => {
    await expect(readEvents(rowsOf(), SLUG, SESSION, 0, 10)).resolves.toEqual([]);
  });

  test("a NULL index is REFUSED, not emitted at 0", async () => {
    // The one that was actively wrong rather than merely lossy. Asserted as a
    // rejection AND, below, as "no page came back with a 0 in it" — a version that
    // only checked the throw would still pass a repair that dropped the row.
    await expect(
      readEvents(rowsOf({ event_index: null, event: "{}" }), SLUG, SESSION, 0, 10),
    ).rejects.toThrow(/non-event/);
  });

  test.each([
    ["an index that is not a number at all", { event_index: "nope", event: "{}" }],
    ["a negative index", { event_index: "-1", event: "{}" }],
    ["an index that is not digits", { event_index: "0x10", event: "{}" }],
    ["a row whose event column is not text", { event_index: "0", event: 7 }],
  ])("refuses %s rather than dropping the row", async (_label, row) => {
    await expect(readEvents(rowsOf(row), SLUG, SESSION, 0, 10)).rejects.toThrow(/non-event/);
  });

  test("ONE unreadable row fails the whole page rather than holing it", async () => {
    // The property, stated the way the bug would have to be re-introduced to
    // break it: a repair that skipped the middle row would answer [0, 2] here,
    // and a caller advancing its cursor past 2 would never see 1 again.
    await expect(
      readEvents(
        rowsOf(
          { event_index: "0", event: "{}" },
          { event_index: null, event: "{}" },
          { event_index: "2", event: "{}" },
        ),
        SLUG,
        SESSION,
        0,
        10,
      ),
    ).rejects.toThrow(/non-event/);
  });

  test("the refusal names neither the sessionId nor the event body", async () => {
    // Same rule as the refusal above: this string reaches a warn line. The event
    // is a caller's own data, so it is the one thing that must not travel with it.
    await expect(
      readEvents(rowsOf({ event_index: null, event: '{"card":"4242"}' }), SLUG, SESSION, 0, 10),
    ).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining("4242") }));
  });

  test("the slug, session id, cursor and limit are all BOUND", async () => {
    const { sql, calls } = createRecordingSql(() => []);
    await readEvents(sql, SLUG, SESSION, 2, 50);
    expect(calls[0]?.params).toEqual([SLUG, SESSION, 2, 50]);
    expect(calls[0]?.query).not.toContain(SLUG);
  });
});
