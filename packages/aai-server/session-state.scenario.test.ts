// Copyright 2026 the AAI authors. MIT license.
/**
 * Does a session's slot state really survive a real Postgres?
 *
 * The Postgres session-state backend (`aai/host/session-state-postgres.ts`) is
 * the durable half of `sessionSlot`, and it lives entirely in the
 * driver↔Postgres seam: a `jsonb` column, an `unnest` upsert, and a value that
 * has already been serialized once by the store above it. That is the exact shape
 * of the bug `jsonb-encoding.scenario.test.ts` exists for — a value encoded
 * twice, so the column holds a jsonb STRING rather than an object — and it is
 * unrepresentable in the memory backend, which holds the same strings and cannot
 * be stricter than the driver beneath it.
 *
 * It is here rather than in `packages/aai` for a boundary reason: `aai` may
 * import no sibling package, so it cannot reach `describeWithPg` — and this repo
 * has ONE spelling for that gate on purpose (see `_pg-test-utils.ts`). This
 * package already imports `@alexkroman1/aai/runtime`, and it owns the sweep that
 * reads the same table, so both ends of the contract are testable from here.
 *
 * Self-cleaning: everything is written under session ids this file owns, in a
 * schema it creates and drops.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 *   pnpm --filter aai-server test:integration
 * ```
 */

import { sessionSlot } from "@alexkroman1/aai";
import {
  createPostgresDb,
  createPostgresStateBackend,
  createSessionEventStream,
  createSessionStateStore,
  SESSION_EVENT_TABLE,
  SESSION_STATE_TABLE,
} from "@alexkroman1/aai/runtime";
import { createToolContext } from "@alexkroman1/aai/testing";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { SWEEP_SESSION_STATE } from "./_session-state-sweep.ts";

/**
 * An app-SHAPED schema, because the sweep only considers `app_` + 16 hex — the
 * identifier rule every statement over a tenant schema re-asserts. A test schema
 * named anything else would be skipped by the sweep and the case would pass
 * vacuously.
 */
const SCHEMA = "app_0123456789abcdef";

type Cart = { items: string[]; total: number; note: string | null };

const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], total: 0, note: null }));

describeWithPg("session state over a real Postgres", () => {
  let db: ReturnType<typeof createPostgresDb>;
  let sql: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;
  /** A handle whose search_path is the test schema, as a guest's own role is. */
  let appDb: ReturnType<typeof createPostgresDb>;

  beforeAll(async () => {
    db = createPostgresDb({ url: pgUrl() });
    sql = db.query;
    await sql(`drop schema if exists ${SCHEMA} cascade`);
    await sql(`create schema ${SCHEMA}`);
    // `search_path` rather than a qualified table name: that is how the platform
    // provisions an app role, so the backend's unqualified SQL is exercised the
    // way a guest runs it.
    appDb = createPostgresDb({ url: `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}` });
  });

  afterAll(async () => {
    await appDb.close();
    await sql(`drop schema if exists ${SCHEMA} cascade`);
    await db.close();
  });

  const storeFor = () =>
    createSessionStateStore({ backend: createPostgresStateBackend({ db: appDb }) });

  /** The event stream over the SAME backend — one store, two consumers. */
  const streamFor = () =>
    createSessionEventStream({ backend: createPostgresStateBackend({ db: appDb }) });

  test("a slot's value survives a new process", async () => {
    // The whole point: the second store shares nothing with the first but the
    // database, which is what a crash, a redeploy or `handoverSlot`'s blue-green
    // swap leaves a reconnecting caller with.
    const first = storeFor();
    // `createToolContext` around the store's OWN view: a real context, with the
    // slots this store holds rather than a detached set.
    const ctx = createToolContext({ sessionId: "s-survive", slots: first.viewFor("s-survive") });
    cartSlot.update(ctx, (cart) => {
      cart.items.push("apple", "pear");
      cart.total = 12.5;
    });
    await first.flush("s-survive");

    const second = storeFor();
    await second.hydrate("s-survive");
    const resumed = createToolContext({
      sessionId: "s-survive",
      slots: second.viewFor("s-survive"),
    });
    expect(cartSlot.get(resumed)).toEqual({
      items: ["apple", "pear"],
      total: 12.5,
      note: null,
    });
  });

  test("the column holds jsonb, not a jsonb STRING", async () => {
    // The double-encoding bug, asked directly. The store hands the backend a
    // string it has already serialized, so a second encode on the way in is one
    // `::jsonb` cast away — and every reader above would still round-trip, which
    // is what makes it invisible without this question.
    const store = storeFor();
    const ctx = createToolContext({ sessionId: "s-jsonb", slots: store.viewFor("s-jsonb") });
    cartSlot.update(ctx, (cart) => cart.items.push("x"));
    await store.flush("s-jsonb");

    const rows = await sql<{ t: string }>(
      `select jsonb_typeof(value) as t from ${SCHEMA}.${SESSION_STATE_TABLE}
       where session_id = $1`,
      ["s-jsonb"],
    );
    expect(rows[0]?.t).toBe("object");
  });

  test("a value with awkward JSON round-trips byte for byte", async () => {
    // Unicode, an empty string, a null, a float and an apostrophe — the classes
    // that break when something along the way is doing its own quoting.
    const store = storeFor();
    const ctx = createToolContext({ sessionId: "s-awkward", slots: store.viewFor("s-awkward") });
    const items = ["café", "", "it's", "日本語", "a\\b", '"quoted"'];
    cartSlot.update(ctx, (cart) => {
      cart.items.push(...items);
      cart.total = 0.1 + 0.2;
      cart.note = null;
    });
    await store.flush("s-awkward");

    const reloaded = storeFor();
    await reloaded.hydrate("s-awkward");
    const ctx2 = createToolContext({
      sessionId: "s-awkward",
      slots: reloaded.viewFor("s-awkward"),
    });
    expect(cartSlot.get(ctx2).items).toEqual(items);
    expect(cartSlot.get(ctx2).total).toBe(0.1 + 0.2);
  });

  test("an unchanged value is not rewritten", async () => {
    // What answers retail's ~106 KB of state being touched on nearly every tool
    // call: the comparison is on the serialization, since the draft model hands
    // the store a new object every time.
    const store = storeFor();
    const ctx = createToolContext({
      sessionId: "s-unchanged",
      slots: store.viewFor("s-unchanged"),
    });
    cartSlot.update(ctx, (cart) => cart.items.push("a"));
    await store.flush("s-unchanged");
    const first = await sql<{ updated_at: string }>(
      `select updated_at from ${SCHEMA}.${SESSION_STATE_TABLE} where session_id = $1`,
      ["s-unchanged"],
    );

    // A mutation that changes nothing observable.
    cartSlot.update(ctx, (cart) => cart.items);
    await store.flush("s-unchanged");
    const second = await sql<{ updated_at: string }>(
      `select updated_at from ${SCHEMA}.${SESSION_STATE_TABLE} where session_id = $1`,
      ["s-unchanged"],
    );
    expect(second[0]?.updated_at).toEqual(first[0]?.updated_at);
  });

  test("two slots are two rows, and a second write upserts rather than duplicating", async () => {
    const other = sessionSlot("flags", () => ({ seen: false }));
    const store = storeFor();
    const ctx = createToolContext({ sessionId: "s-rows", slots: store.viewFor("s-rows") });
    cartSlot.update(ctx, (cart) => cart.items.push("a"));
    other.update(ctx, (flags) => {
      flags.seen = true;
    });
    await store.flush("s-rows");
    cartSlot.update(ctx, (cart) => cart.items.push("b"));
    await store.flush("s-rows");

    const rows = await sql<{ slot: string }>(
      `select slot from ${SCHEMA}.${SESSION_STATE_TABLE} where session_id = $1 order by slot`,
      ["s-rows"],
    );
    expect(rows.map((r) => r.slot)).toEqual(["cart", "flags"]);
  });

  test("discard reclaims a session's rows and nobody else's", async () => {
    const store = storeFor();
    for (const sid of ["s-keep", "s-drop"]) {
      const ctx = createToolContext({ sessionId: sid, slots: store.viewFor(sid) });
      cartSlot.update(ctx, (cart) => cart.items.push(sid));
      await store.flush(sid);
    }
    store.discard("s-drop");
    await expect
      .poll(async () => {
        const rows = await sql<{ session_id: string }>(
          `select session_id from ${SCHEMA}.${SESSION_STATE_TABLE}
           where session_id in ('s-keep', 's-drop')`,
        );
        return rows.map((r) => r.session_id);
      })
      .toEqual(["s-keep"]);
  });

  test("the platform's TTL sweep reclaims aged rows and leaves fresh ones", async () => {
    // The sweep is plpgsql over `information_schema`, so this is the only tier
    // that can run it at all — and the schema above is app-SHAPED precisely so it
    // is in scope. Ageing is done by hand: the retention window is two days.
    const store = storeFor();
    for (const sid of ["s-old", "s-new"]) {
      const ctx = createToolContext({ sessionId: sid, slots: store.viewFor(sid) });
      cartSlot.update(ctx, (cart) => cart.items.push(sid));
      await store.flush(sid);
    }
    await sql(
      `update ${SCHEMA}.${SESSION_STATE_TABLE} set updated_at = now() - interval '3 days'
       where session_id = $1`,
      ["s-old"],
    );

    await sql(SWEEP_SESSION_STATE);

    const rows = await sql<{ session_id: string }>(
      `select session_id from ${SCHEMA}.${SESSION_STATE_TABLE}
       where session_id in ('s-old', 's-new')`,
    );
    expect(rows.map((r) => r.session_id)).toEqual(["s-new"]);
  });

  test("a session's EVENT log survives a new process, at its own indices", async () => {
    // The driver is the only thing that can fail here — an index round-tripping
    // through `bigint` as a string, a `jsonb` column rejecting what the memory
    // backend holds happily — which is why this tier exists at all.
    const first = streamFor();
    first.append("s-ev", { type: "user-transcript.committed", text: "my order is 4471" });
    first.append("s-ev", { type: "agent-transcript.committed", text: "Found it." });
    await first.flush("s-ev");

    const second = streamFor();
    await second.hydrate("s-ev");
    const page = await second.read("s-ev", 0);

    expect(page.events.map((e: { type: string }) => e.type)).toEqual([
      "user-transcript.committed",
      "agent-transcript.committed",
    ]);
    // The position continues, so a resumed session cannot overwrite its own log.
    expect(second.tail("s-ev")).toBe(2);
  });

  test("a re-appended index is a no-op, so a retried flush cannot duplicate", async () => {
    const stream = streamFor();
    stream.append("s-retry", { type: "speech.started" });
    await stream.flush("s-retry");
    // The same index again — what a retry after a partial failure sends.
    const backend = createPostgresStateBackend({ db: appDb });
    await backend.appendEvents("s-retry", [{ index: 0, json: '{"type":"speech.stopped"}' }]);

    const rows = await sql<{ count: number }>(
      `select count(*)::int as count from ${SCHEMA}.${SESSION_EVENT_TABLE} where session_id = $1`,
      ["s-retry"],
    );
    expect(rows[0]?.count).toBe(1);
  });

  test("the TTL sweep reclaims aged EVENT rows too", async () => {
    // Both tables, one job: a session's durable footprint is its slot values AND
    // its event log, and a sweep that reclaimed one would leave the other growing
    // in a schema the author sees as their own database usage.
    const stream = streamFor();
    for (const sid of ["e-old", "e-new"]) {
      stream.append(sid, { type: "speech.started" });
      await stream.flush(sid);
    }
    // Aged by `created_at`, not `updated_at`: an event row is append-only and
    // never rewritten, so that is the only time it has.
    await sql(
      `update ${SCHEMA}.${SESSION_EVENT_TABLE} set created_at = now() - interval '3 days'
       where session_id = $1`,
      ["e-old"],
    );

    await sql(SWEEP_SESSION_STATE);

    const rows = await sql<{ session_id: string }>(
      `select distinct session_id from ${SCHEMA}.${SESSION_EVENT_TABLE}
       where session_id in ('e-old', 'e-new')`,
    );
    expect(rows.map((r) => r.session_id)).toEqual(["e-new"]);
  });
});
