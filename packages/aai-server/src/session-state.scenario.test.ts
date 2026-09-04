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
 * package already imports `@alexkroman1/aai-runtime`, and it owns the sweep that
 * reads the same table, so both ends of the contract are testable from here.
 *
 * Self-cleaning: everything is written under session ids this file owns, in a
 * schema it creates and drops.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { sessionSlot } from "@alexkroman1/aai";
import { createToolContext } from "@alexkroman1/aai/testing";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import {
  createPostgresStateBackend,
  createSessionEventStream,
  createSessionStateStore,
  SESSION_EVENT_TABLE,
  SESSION_STATE_TABLE,
  sessionStateDdl,
} from "@alexkroman1/aai-runtime/internal";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";

/**
 * A real DATABASE with the tables in `public`, which is the layout the surviving
 * postgres backend actually meets.
 *
 * Two shapes preceded it and both are gone: an app-shaped SCHEMA in the platform
 * database with `search_path` pinned to it, then a per-app database of its own.
 * The platform provisions neither now — this backend runs only against a
 * `DATABASE_URL` the AUTHOR supplied — so what is left to test is a plain database
 * with no pin, which is what this creates. The name keeps the old `app_<hex>` shape
 * only so the fixture is recognisable in a stray `\l` listing.
 */
const APP_DB = "app_0123456789abcdef";
/** The role's password. Fixed — a test double has no business being random. */
const APP_PASSWORD = "scenario-app-role-pw";

type Cart = { items: string[]; total: number; note: string | null };

const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], total: 0, note: null }));

/**
 * The schema the backend's DDL targets.
 *
 * It used to come from `app-database.ts` as `APP_DB_SCHEMA`, because these tables
 * lived in each app's own provisioned database. There are no app databases now, and
 * the POSTGRES backend survives only where a `DATABASE_URL` is the author's own — a
 * self-hosted server, or `aai dev` — so the schema is this suite's to name.
 */
const APP_DB_SCHEMA = "public";

describeWithPg("session state over a real Postgres", () => {
  /** The PLATFORM connection — what creates and drops the app's database. */
  let platform: ReturnType<typeof createPostgresDb>;
  /** A connection INTO the app's own database, as the ADMIN — what provisions it. */
  let appDb: ReturnType<typeof createPostgresDb>;
  /** The same database as the APP's own role — what a guest really connects as. */
  let tenantDb: ReturnType<typeof createPostgresDb>;
  let sql: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;

  /** Swap the app's database into the platform URL, keeping the admin's credentials. */
  function appUrl(): string {
    const parsed = new URL(pgUrl());
    parsed.pathname = `/${APP_DB}`;
    return parsed.toString();
  }

  /** The same URL as the app's OWN role — `DATABASE_URL` as a guest receives it. */
  function tenantUrl(): string {
    const parsed = new URL(appUrl());
    parsed.username = APP_DB;
    parsed.password = APP_PASSWORD;
    return parsed.toString();
  }

  beforeAll(async () => {
    platform = createPostgresDb({ url: pgUrl() });
    await platform.query(`drop database if exists "${APP_DB}" with (force)`);
    await platform.query(`drop role if exists "${APP_DB}"`);
    await platform.query(`create database "${APP_DB}"`);
    // The APP's own login role, because the store must be exercised as the TENANT
    // and not as the admin. This suite connected as the admin for everything,
    // which made it structurally blind to the bug that shipped:
    // `provisionAppDatabase` creates the session-state tables as the ADMIN, so the
    // app role — holding only `usage, create` on the schema — had no privileges on
    // them at all, and every session failed
    // `42501 permission denied for table aai_session_events`. No admin connection
    // can see that, however real the database behind it is.
    await platform.query(
      `create role "${APP_DB}" login password '${APP_PASSWORD}' connection limit 10`,
    );
    appDb = createPostgresDb({ url: appUrl() });
    // `sql` addresses the APP's database, because that is where the tables are —
    // every assertion below reads the tenant's own rows, not the platform's.
    sql = appDb.query;
    // The TABLES come with the database, exactly as `provisionAppDatabase` gives
    // them to a real app — the backend creates none of its own any more (see
    // `sessionStateDdl`). Applying the SDK's own DDL rather than a copy of it is
    // what keeps this suite testing the shipped shape: a hand-written `create
    // table` here would go on passing after the real one changed.
    for (const statement of sessionStateDdl(APP_DB_SCHEMA)) {
      await sql(statement);
    }
    // The grants `provisionAppDatabase` issues alongside that DDL, spelled the
    // same way — so a change to what the platform grants fails here.
    await sql(`grant usage, create on schema ${APP_DB_SCHEMA} to "${APP_DB}"`);
    await sql(
      `grant select, insert, update, delete on ${APP_DB_SCHEMA}.${SESSION_STATE_TABLE},` +
        ` ${APP_DB_SCHEMA}.${SESSION_EVENT_TABLE} to "${APP_DB}"`,
    );
    tenantDb = createPostgresDb({ url: tenantUrl() });
  });

  afterAll(async () => {
    await tenantDb?.close();
    await appDb.close();
    await platform.query(`drop database if exists "${APP_DB}" with (force)`);
    await platform.query(`drop role if exists "${APP_DB}"`);
    await platform.close();
  });

  const storeFor = () =>
    createSessionStateStore({ backend: createPostgresStateBackend({ db: tenantDb }) });

  /** The event stream over the SAME backend — one store, two consumers. */
  const streamFor = () =>
    createSessionEventStream({ backend: createPostgresStateBackend({ db: tenantDb }) });

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
      `select jsonb_typeof(value) as t from ${APP_DB_SCHEMA}.${SESSION_STATE_TABLE}
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
      `select updated_at from ${APP_DB_SCHEMA}.${SESSION_STATE_TABLE} where session_id = $1`,
      ["s-unchanged"],
    );

    // A mutation that changes nothing observable.
    cartSlot.update(ctx, (cart) => cart.items);
    await store.flush("s-unchanged");
    const second = await sql<{ updated_at: string }>(
      `select updated_at from ${APP_DB_SCHEMA}.${SESSION_STATE_TABLE} where session_id = $1`,
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
      `select slot from ${APP_DB_SCHEMA}.${SESSION_STATE_TABLE} where session_id = $1 order by slot`,
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
    await vi.waitFor(async () => {
      const rows = await sql<{ session_id: string }>(
        `select session_id from ${APP_DB_SCHEMA}.${SESSION_STATE_TABLE}
         where session_id in ('s-keep', 's-drop')`,
      );
      expect(rows.map((r) => r.session_id)).toEqual(["s-keep"]);
    });
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
    const backend = createPostgresStateBackend({ db: tenantDb });
    await backend.appendEvents("s-retry", [{ index: 0, json: '{"type":"speech.stopped"}' }]);

    const rows = await sql<{ count: number }>(
      `select count(*)::int as count from ${APP_DB_SCHEMA}.${SESSION_EVENT_TABLE} where session_id = $1`,
      ["s-retry"],
    );
    expect(rows[0]?.count).toBe(1);
  });
});
