// Copyright 2026 the AAI authors. MIT license.
/**
 * The session-state contract's FOURTH arm: `createPlatformStateBackend` over the
 * REAL handler and a real Postgres.
 *
 * `aai-runtime/session-state-conformance.ts` owns the case list and the argument
 * for the pattern; read it first. What this file adds is the one arm that
 * package cannot stand up, and it is the arm the other three are structurally
 * blind in:
 *
 * - the **memory** arm is the reference;
 * - the **postgres** arm is the self-hosted backend against a database;
 * - the **platform** arm in the unit tier is `createPlatformStateBackend` over a
 *   FAKE transport that parses what the handler parses and then delegates every
 *   SEMANTIC to the memory reference. Its own header says so. So it tests the
 *   guest side of the wire — the `{method, …}` body shape, `toSlotMap`,
 *   `toEvents`, the `event`/`json` rename — and **cannot represent a single bug
 *   `platform-session-state.ts`'s own SQL could have**;
 * - **this** arm is that last mile: the runtime's client, the real
 *   `POST /:slug/session-state` route with its bearer check, its body cap and
 *   its field parsing, `platform-session-state.ts`'s six statements, and the
 *   platform's own `aai_platform.session_slots` / `session_events` under the
 *   shipped migrations.
 *
 * The precedent is not theoretical. `journal-conformance-platform.scenario.test.ts`
 * beside this file — the same fourth-arm shape one contract over — found
 * `createRun` answering a duplicate run id with SUCCESS while its equivalent
 * fake-transport arm sat green: 123 passed against 1 failed, same tree, same
 * moment.
 *
 * ## What this arm can see that the fake one cannot
 *
 * Three things, all named in advance by
 * `aai-runtime/session-state-conformance.test.ts`'s own header as consequences
 * it reports green:
 *
 * - **`discard`'s reach.** The reference drops slots AND events; the platform's
 *   CTE drops both. They agree *by luck* rather than by construction, so the
 *   fake arm would not notice the platform dropping one table — its reference
 *   would drop the other one for it. `discard empties BOTH platform tables`
 *   below asks the DATABASE, which is the only place that question exists.
 * - **`jsonb` normalization.** The fake stores the string it is handed; these
 *   columns re-serialize. The shared cases compare parsed values for exactly
 *   that reason, so `a jsonb column re-serializes` below pins the divergence
 *   they decline to rest on.
 * - **A `bigint` answer arriving as a STRING.** `nextEventIndex` computes
 *   `coalesce(max(event_index), -1) + 1` over a `bigint` column, and postgres.js
 *   hands an `int8` back as a string — so the read in that function is
 *   load-bearing, and BOTH ends refuse an answer they cannot read rather than
 *   coercing it (0 is the one value that must never be guessed, because a
 *   resumed session restarting its log at 0 overwrites its own history). Over
 *   the fake transport the answer is a JS number by construction and the whole
 *   path is invisible. Here every `countEvents` case exercises it, and
 *   `countEvents answers a JSON number` states it directly.
 *
 *   This is also where a defence in depth used to point the WRONG WAY, which is
 *   worth recording because it made this arm report health it did not have. The
 *   route ended in `Number.isInteger(next) && next >= 0 ? next : 0`, so an
 *   unreadable answer became "this session has no events" — and under an A/B
 *   that removed the string read, the zero-log cases below passed because of
 *   that FALLBACK rather than because anything was right, while the six
 *   non-zero ones failed. `nextEventIndex` throws now (`withReserved` maps it to
 *   a 503), so removing the read reddens every `countEvents` case on this arm
 *   including the zero-log ones. `platform-session-state.test.ts` pins the same
 *   two facts in the unit tier, where they no longer need a database to be seen.
 *
 * ## What is REAL here, and what is not
 *
 * Real: the route, the guest bearer, the 8 MiB body cap, `requiredString` /
 * `requiredInt` / `slotMap` / `eventList`, every statement, and the platform's
 * schema (`ensurePlatformTables`, i.e. the shipped migrations).
 *
 * Not real, deliberately: the bundle store is the in-memory one, because what an
 * agents ROW is for on this route is a version to derive a bearer from — so the
 * FK target the two session tables cascade from is seeded straight into Postgres
 * beside it. And `fakeAdminDbOver` stands in for the reserved-connection pool: a
 * session-state statement takes no advisory lock, so what `withReserved`
 * contributes to these cases is its error mapping, which is exercised for real.
 *
 * ## What even THIS arm cannot see
 *
 * - **A `501`.** It is what the route answers when a deployment has no platform
 *   database at all, and this arm has one by construction. `notConfigured`'s
 *   contract — terminal for the guest, no fallback to memory — is
 *   `session-state-handler.test.ts`'s.
 * - **A REFUSAL the client turns into something other than a throw**, because
 *   there is none: every method propagates by design, so this arm sees a status
 *   only where a test asks the route directly.
 * - **Cross-SLUG tenancy.** One agent's rows are invisible to another because
 *   the slug is in the primary key and comes off the BEARER, which one arm with
 *   one bearer cannot demonstrate. `platform-session-state.scenario.test.ts`
 *   drives two tenants' rows for that, and stays.
 * - **Concurrency.** The cases are sequential; a racing commit and discard on
 *   one session is nothing the interface promises about.
 *
 * ```sh
 * pnpm test:pg pnpm --filter aai-server test:scenario
 * ```
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import {
  createPlatformStateBackend,
  loadSessionStateConformance,
} from "@alexkroman1/aai-runtime/internal";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { ensurePlatformTables } from "./platform-schema-test-utils.ts";
import type { SqlExec } from "./secret-store.ts";
import {
  bearerFor,
  createTestOrchestrator,
  deploy,
  fakeAdminDbOver,
  type TestFetch,
} from "./test-utils.ts";

/**
 * Awaited at the TOP, so the cases can be declared synchronously inside the
 * `describe` body below — which is what a suite body needs.
 *
 * A LOADER rather than a plain import because the case modules pull `vitest`,
 * which is an optional peer of a package whose `/internal` subpath is imported
 * for VALUES by the published CLI. `aai-runtime/internal.ts` carries the
 * measurement.
 */
const { sessionStateConformance, sessionStateIds } = await loadSessionStateConformance();

/** This arm's tenant. Its own slug, so nothing it writes is another suite's. */
const SLUG = "session-state-conformance-arm";

describeWithPg("the session-state contract over the platform's REAL handler", () => {
  let db: ReturnType<typeof createPostgresDb>;
  let sql: SqlExec;
  let backend: ReturnType<typeof createPlatformStateBackend>;
  /** The route as an HTTP surface, for the claims the client hides: a STATUS, a TYPE. */
  let call: (body: unknown) => Promise<Response>;

  beforeAll(async () => {
    // `pgUrl()` inside the hook and never at the top of this body: vitest
    // EXECUTES a skipped describe's callback to enumerate what it is skipping,
    // so a read up there fails the file instead of skipping it.
    db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (query, params) => db.query(query, params);
    await ensurePlatformTables(sql);

    const harness = await createTestOrchestrator({ adminDb: fakeAdminDbOver(sql) });
    await deploy(harness.fetch, { key: "key1", body: { slug: SLUG } });
    // The agents row the two session tables cascade FROM. The orchestrator above
    // keeps its own copy in the memory bundle store, which is where the bearer's
    // version comes from; this is the foreign key, and it has to be a real row in
    // the real database or every `commit` fails on it. The columns are the shipped
    // table's NOT NULLs with no default, listed rather than derived so a new
    // required column fails here instead of six statements later.
    await sql(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
      [SLUG],
    );

    const token = await bearerFor(harness.store, SLUG);
    call = (body) =>
      harness.fetch(`/${SLUG}/session-state`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    backend = createPlatformStateBackend({
      // The base is slug-scoped exactly as `AAI_PLATFORM_BASE_URL` is in a
      // guest's boot env, so the client composes the same path a deployed guest
      // does and cannot name another tenant's.
      base: `/${SLUG}`,
      token,
      fetch: routeFetch(harness.fetch),
    });
  });

  afterAll(async () => {
    // The agents row takes every session row with it — the cascade
    // `platform-session-state.scenario.test.ts` asserts directly. A case that
    // left rows behind would collide with the next run of this file on the same
    // database, which is what `uid()` exists for.
    await sql?.("delete from aai_platform.agents where slug = $1", [SLUG]);
    await db?.close();
  });

  /** How many rows this slug holds in one of the two tables, for one session. */
  const rowsIn = async (table: string, sessionId: string): Promise<number> => {
    const rows = await sql(
      `select count(*)::int as n from aai_platform.${table}
        where slug = $1 and session_id = $2`,
      [SLUG, sessionId],
    );
    return Number(rows[0]?.n);
  };

  test("discard empties BOTH platform tables, which no other arm can ask", async () => {
    // The shared cases assert the SLOTS and say nothing about the log, because
    // the interface says `discard` "reclaims what the backend is ALLOWED to
    // reclaim, which is not always both" — and the three backends really give
    // three answers (memory both, postgres slots only, platform both). So this
    // is the question that arm cannot express: the fake-transport arm reports
    // the reference's own reach, so the platform dropping ONE table would leave
    // it green with orphaned event rows accumulating under every ended session
    // until the retention sweep.
    const sessionId = sessionStateIds("reach")();
    await backend.commit(sessionId, new Map([["cart", `{"items":["apple"]}`]]));
    await backend.appendEvents(sessionId, [{ index: 0, json: `{"type":"x"}` }]);
    expect(await rowsIn("session_slots", sessionId)).toBe(1);
    expect(await rowsIn("session_events", sessionId)).toBe(1);

    await backend.discard(sessionId);
    expect(await rowsIn("session_slots", sessionId)).toBe(0);
    expect(await rowsIn("session_events", sessionId)).toBe(0);
  });

  test("a jsonb column re-serializes, so a value survives by MEANING not bytes", async () => {
    // Pinned rather than assumed. `meaningOf` in the shared cases parses every
    // value precisely because this is true here and false in memory, and the
    // fake-transport arm — which stores the string it is handed — is on the
    // memory side of it. A reader who assumed byte fidelity would write a
    // passing spec against three arms and a failing one against production.
    const sessionId = sessionStateIds("jsonb")();
    await backend.commit(sessionId, new Map([["cart", `{"items":[1,2]}`]]));
    const loaded = await backend.load(sessionId);
    expect(loaded.get("cart")).toBe(`{"items": [1, 2]}`);
    expect(JSON.parse(loaded.get("cart") ?? "null")).toEqual({ items: [1, 2] });
  });

  test("countEvents answers a JSON number, not the bigint's string", async () => {
    // `event_index` is `bigint`, so `coalesce(max(...), -1) + 1` comes back from
    // postgres.js as the STRING `"6"` — which is why `nextEventIndex` reads it
    // rather than passing it on. Drop that read and the route refuses with a
    // 503, so every `countEvents` case on this arm fails, the zero-log ones
    // included: `"0"` is just as unreadable as `"6"`. That last clause is the
    // fix — it used to be a `: 0` fallback, under which the zero-log cases
    // passed on the fallback while the six non-zero ones failed. Over a fake
    // transport the answer is a JS number by construction, so nothing there can
    // see any of it. Asserted through the ROUTE because the client's own
    // refusal is what would hide the type from a backend-level assertion.
    const sessionId = sessionStateIds("bigint")();
    await backend.appendEvents(sessionId, [{ index: 5, json: `{"type":"f"}` }]);
    const answered: unknown = await (await call({ method: "countEvents", sessionId })).json();
    expect(answered).toEqual({ result: 6 });
  });

  test("an EMPTY sessionId is refused with a 400, where both other backends store it", async () => {
    // The divergence the shared table names and declines to assert: `""` is an
    // ordinary key in memory and in Postgres, and this route reads the field
    // with `requiredString`, which refuses it. Unreachable — every session id is
    // minted — and the route's refusal is the stricter, better answer, so it is
    // pinned HERE rather than mandated for every backend. A status, which the
    // client folds into one `Error`.
    const refused = await call({ method: "load", sessionId: "" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("sessionId");
  });

  test("a slot value that is not JSON is REFUSED by the column, as a 503", async () => {
    // The other point the shared table leaves under-specified out loud: both
    // databases cast to `jsonb` and refuse (`22P02`), memory stores any string.
    // Nothing above this seam can produce one — every value arrives from
    // `JSON.stringify` — and the refusal is the whole reason the column is
    // `jsonb` rather than `text`, a check no in-memory arm can fake. 503 rather
    // than 400 because `withReserved` cannot tell a malformed value from a
    // partitioned database, and from the guest's side both are "the flush did
    // not land"; the interface's answer to a failed flush is a log line, not a
    // failed turn.
    const sessionId = sessionStateIds("nonjson")();
    const refused = await call({
      method: "commit",
      sessionId,
      values: { bad: "not json at all" },
    });
    expect(refused.status).toBe(503);
    // And nothing landed. A partial commit would be worse than a refused one.
    expect(await rowsIn("session_slots", sessionId)).toBe(0);
  });

  // ONE backend across every case — a scenario arm cannot afford a database per
  // test — which is exactly why every case mints its session id from `uid()`.
  sessionStateConformance({
    label: "platform (real handler, real Postgres)",
    backend: () => backend,
    uid: sessionStateIds("pf"),
  });
});

/**
 * The orchestrator's `app.request` as the client's `fetch` seam.
 *
 * The client builds one relative URL per call and hands it to whatever `fetch` it
 * was given, so the request really is parsed, routed and authorized by Hono — no
 * handler is called directly here.
 */
function routeFetch(fetch: TestFetch): typeof globalThis.fetch {
  return async (input, init) => await fetch(String(input), init);
}
