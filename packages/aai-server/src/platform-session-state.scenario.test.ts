// Copyright 2026 the AAI authors. MIT license.
/**
 * Turn-level durability on the platform, against a real database.
 *
 * Real Postgres, because every property worth asserting here is the SCHEMA's: the
 * primary key is what makes a retried flush idempotent, the `jsonb` columns are what
 * reject a value that is not JSON, and `max(event_index) + 1` is arithmetic a fake
 * would have to reimplement to be wrong in the same way.
 *
 * Two of these come with warnings already written down in
 * `session-state-postgres.ts`, and both are the kind of thing that fails silently:
 *
 * - `countEvents` must be `max + 1`, never a count. Under a count a resumed session
 *   is handed an index it has already used, its `tail` goes BACKWARDS, and the
 *   re-appended events are dropped by `on conflict do nothing`.
 * - An append at an index already stored must be a NO-OP, because a retried flush
 *   after a partial failure must not be the thing that breaks a call.
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { ensurePlatformTables } from "./platform-schema-test-utils.ts";
import {
  appendEvents,
  commitSlots,
  discardSession,
  loadSlots,
  nextEventIndex,
  readEvents,
} from "./platform-session-state.ts";
import type { SqlExec } from "./secret-store.ts";

describeWithPg("platform session state", () => {
  let close: () => Promise<void>;
  let sql: SqlExec;

  const SLUGS = ["pss-a", "pss-b"];
  const SESSION = "sess_1";

  const seedAgent = (slug: string) =>
    sql(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
      [slug],
    );

  beforeAll(async () => {
    const db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (q, p) => db.query(q, p);
    close = () => db.close();
    await ensurePlatformTables(sql);
    for (const slug of SLUGS) await seedAgent(slug);
  });

  beforeEach(async () => {
    // Only this suite's rows, never the tables.
    await sql("delete from aai_platform.session_slots where slug = any($1)", [SLUGS]);
    await sql("delete from aai_platform.session_events where slug = any($1)", [SLUGS]);
    for (const slug of SLUGS) await seedAgent(slug);
  });

  afterAll(async () => {
    await sql("delete from aai_platform.session_slots where slug = any($1)", [SLUGS]);
    await sql("delete from aai_platform.session_events where slug = any($1)", [SLUGS]);
    await sql("delete from aai_platform.agents where slug = any($1)", [SLUGS]);
    await close();
  });

  /** Events with their payloads parsed — see the whitespace spec below. */
  const parsed = (events: readonly { index: number; event: string }[]) =>
    events.map((e) => ({ index: e.index, event: JSON.parse(e.event) as unknown }));

  const A = () => SLUGS[0] as string;
  const B = () => SLUGS[1] as string;

  /**
   * By MEANING, not by bytes.
   *
   * `jsonb` parses on write — the check this process cannot fake — and the cost is
   * that `{"items":[1,2]}` comes back as `{"items": [1, 2]}`. Harmless, since every
   * consumer parses, but the MEMORY backend does preserve bytes, so the difference
   * is real and asserting byte-identity here would be asserting something the
   * column does not promise.
   */
  test("a committed slot loads back with its meaning intact", async () => {
    await commitSlots(sql, A(), SESSION, { cart: '{"items":[1,2]}' });
    const back = await loadSlots(sql, A(), SESSION);
    expect(JSON.parse(back.cart ?? "null")).toEqual({ items: [1, 2] });
  });

  test("whitespace is normalized rather than preserved, which is jsonb's doing", async () => {
    // Written down as a spec because it is a real difference from the memory
    // backend, and the kind a reader would otherwise discover from a failing
    // assertion of their own.
    await commitSlots(sql, A(), SESSION, { cart: '{"a":1}' });
    expect((await loadSlots(sql, A(), SESSION)).cart).toBe('{"a": 1}');
  });

  test("a fresh session loads nothing rather than failing", async () => {
    expect(await loadSlots(sql, A(), "never-seen")).toEqual({});
  });

  test("commits several slots in ONE statement, and all of them land", async () => {
    // `unnest`, so a flush is one round trip however many slots a tool changed.
    await commitSlots(sql, A(), SESSION, { a: '"1"', b: '"2"', c: '"3"' });
    expect(await loadSlots(sql, A(), SESSION)).toEqual({ a: '"1"', b: '"2"', c: '"3"' });
  });

  test("a second commit of the same slot REPLACES it", async () => {
    await commitSlots(sql, A(), SESSION, { cart: '"first"' });
    await commitSlots(sql, A(), SESSION, { cart: '"second"' });
    expect(await loadSlots(sql, A(), SESSION)).toEqual({ cart: '"second"' });
  });

  test("committing nothing is a no-op, not a statement that fails", async () => {
    // A tool call that changed no slot still flushes.
    await expect(commitSlots(sql, A(), SESSION, {})).resolves.toBeUndefined();
  });

  /**
   * The one check the process above cannot fake.
   *
   * `value` is `jsonb` rather than `text` precisely so the column rejects a
   * non-JSON value at write time — the class of bug an in-memory store cannot
   * represent, because it holds JS objects.
   */
  test("refuses a slot value that is not JSON", async () => {
    await expect(commitSlots(sql, A(), SESSION, { bad: "not json at all" })).rejects.toThrow();
  });

  /**
   * Tenancy is in the KEY, so this needs no check to pass.
   *
   * Two agents using the SAME session id — which they may, since ids are generated
   * per process — must not see each other's slots.
   */
  test("two agents with the same session id do not share slots", async () => {
    await commitSlots(sql, A(), SESSION, { who: '"a"' });
    await commitSlots(sql, B(), SESSION, { who: '"b"' });
    expect(await loadSlots(sql, A(), SESSION)).toEqual({ who: '"a"' });
    expect(await loadSlots(sql, B(), SESSION)).toEqual({ who: '"b"' });
  });

  test("discarding a session removes its slots and events, and only its own", async () => {
    await commitSlots(sql, A(), SESSION, { x: '"1"' });
    await appendEvents(sql, A(), SESSION, [{ index: 0, event: '{"t":"a"}' }]);
    await commitSlots(sql, A(), "other", { y: '"2"' });
    await discardSession(sql, A(), SESSION);
    expect(await loadSlots(sql, A(), SESSION)).toEqual({});
    expect(await readEvents(sql, A(), SESSION, 0, 10)).toEqual([]);
    expect(await loadSlots(sql, A(), "other")).toEqual({ y: '"2"' });
  });

  test("deleting the agent takes its session state with it", async () => {
    await commitSlots(sql, B(), SESSION, { x: '"1"' });
    await appendEvents(sql, B(), SESSION, [{ index: 0, event: '{"t":"a"}' }]);
    await sql("delete from aai_platform.agents where slug = $1", [B()]);
    expect(await loadSlots(sql, B(), SESSION)).toEqual({});
    expect(await readEvents(sql, B(), SESSION, 0, 10)).toEqual([]);
  });

  test("appends events at the indices they carry, in order", async () => {
    await appendEvents(sql, A(), SESSION, [
      { index: 0, event: '{"t":"a"}' },
      { index: 1, event: '{"t":"b"}' },
    ]);
    expect(parsed(await readEvents(sql, A(), SESSION, 0, 10))).toEqual([
      { index: 0, event: { t: "a" } },
      { index: 1, event: { t: "b" } },
    ]);
  });

  test("reads from a start index, and honours the limit", async () => {
    await appendEvents(
      sql,
      A(),
      SESSION,
      [0, 1, 2, 3].map((index) => ({ index, event: `{"n":${index}}` })),
    );
    expect((await readEvents(sql, A(), SESSION, 2, 10)).map((e) => e.index)).toEqual([2, 3]);
    expect((await readEvents(sql, A(), SESSION, 0, 2)).map((e) => e.index)).toEqual([0, 1]);
  });

  /**
   * A retried flush must not be the thing that breaks a call.
   *
   * The primary key plus `on conflict do nothing` is what makes this a no-op, and
   * without it the second attempt after a partial failure raises a unique
   * violation inside a tool call that had already succeeded.
   */
  test("re-appending a stored index is a NO-OP, not an error", async () => {
    await appendEvents(sql, A(), SESSION, [{ index: 0, event: '{"t":"first"}' }]);
    await expect(
      appendEvents(sql, A(), SESSION, [
        { index: 0, event: '{"t":"second"}' },
        { index: 1, event: '{"t":"new"}' },
      ]),
    ).resolves.toBeUndefined();
    // The stored one is UNCHANGED — `do nothing`, not `do update`. An event log
    // that rewrote history would stop describing what happened.
    expect(parsed(await readEvents(sql, A(), SESSION, 0, 10))).toEqual([
      { index: 0, event: { t: "first" } },
      { index: 1, event: { t: "new" } },
    ]);
  });

  test("appending nothing is a no-op", async () => {
    await expect(appendEvents(sql, A(), SESSION, [])).resolves.toBeUndefined();
  });

  test("two agents with the same session id do not share an event log", async () => {
    await appendEvents(sql, A(), SESSION, [{ index: 0, event: '{"who":"a"}' }]);
    await appendEvents(sql, B(), SESSION, [{ index: 0, event: '{"who":"b"}' }]);
    expect(parsed(await readEvents(sql, A(), SESSION, 0, 10))).toEqual([
      { index: 0, event: { who: "a" } },
    ]);
    expect(parsed(await readEvents(sql, B(), SESSION, 0, 10))).toEqual([
      { index: 0, event: { who: "b" } },
    ]);
  });

  test("an empty log's next index is 0", async () => {
    expect(await nextEventIndex(sql, A(), SESSION)).toBe(0);
  });

  test("the next index is one past the highest, for a dense log", async () => {
    await appendEvents(
      sql,
      A(),
      SESSION,
      [0, 1, 2].map((index) => ({ index, event: "{}" })),
    );
    expect(await nextEventIndex(sql, A(), SESSION)).toBe(3);
  });

  /**
   * THE trap, and the reason it is `max + 1` rather than a count.
   *
   * The log need not be dense: an event past the size cap advances the position
   * without being stored, and a partly-failed flush leaves a hole. A count here
   * answers 3 for a log whose highest index is 9 — so a resumed session restarts at
   * 3, its `tail` goes BACKWARDS, and every re-used index is silently dropped by the
   * `on conflict do nothing` above.
   */
  test("the next index is one past the highest even when the log has HOLES", async () => {
    await appendEvents(sql, A(), SESSION, [
      { index: 0, event: "{}" },
      { index: 5, event: "{}" },
      { index: 9, event: "{}" },
    ]);
    // Three rows stored, highest index 9.
    expect((await readEvents(sql, A(), SESSION, 0, 100)).length).toBe(3);
    expect(await nextEventIndex(sql, A(), SESSION)).toBe(10);
  });

  test("the next index is per session and per agent", async () => {
    await appendEvents(sql, A(), SESSION, [{ index: 7, event: "{}" }]);
    expect(await nextEventIndex(sql, A(), "other")).toBe(0);
    expect(await nextEventIndex(sql, B(), SESSION)).toBe(0);
  });
});
