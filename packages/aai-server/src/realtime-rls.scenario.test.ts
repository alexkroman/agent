// Copyright 2026 the AAI authors. MIT license.
/**
 * Does the change stream still deliver once RLS is enabled on the watched
 * tables?
 *
 * `20260807000000_platform_rls.sql` says this cannot be checked from a test
 * suite, and until there was a Realtime to test against, it could not:
 *
 * > These statements rest on one claim that cannot be checked from a test
 * > suite: that walrus — Realtime's per-subscriber row-visibility filter —
 * > still sees rows for a BYPASSRLS subscriber once RLS is enabled on the
 * > table.
 *
 * A local `supabase start` stack has walrus in it, so the claim is testable
 * after all — which matters because the failure it guards is SILENT. Filtered
 * subscribes stop, the service boots healthy, and it merely stops invalidating
 * resident sandboxes on redeploy and pushing studio SSE. Nothing raises; there
 * is no log line to grep for. Only the POSITIVE signal distinguishes a working
 * stream from a dead one, which is why every assertion here waits for a frame
 * to arrive rather than for an error not to.
 *
 * Complements `platform-schema.scenario.test.ts`, which applies the same
 * migrations to a stock Postgres and drives the stores against them. That
 * covers the SQL and the owner-connection path (owners bypass policies, so
 * enabling RLS is inert for the platform's own queries). It has no Realtime,
 * so the subscriber path — the half with the silent failure mode — was
 * uncovered.
 *
 * Drives the REAL `createRealtimePlatformEvents`, not a re-implementation of
 * it: the channel topics, the `postgres_changes` filter strings, and the
 * handler-side `accepts` predicates are the things under test, and a test that
 * spelled its own subscribe would be asserting against its own copy.
 *
 * ## Running it
 *
 * ```sh
 * supabase start          # applies supabase/migrations on init
 * pnpm test:pg            # resolves the stack and runs the tier against it
 * ```
 *
 * That is the whole of it now, and it was not: this suite's gate is a
 * conjunction over the Supabase trio, its header documented those as values a
 * human pastes out of `supabase status -o env`, and NOTHING in the repo resolved
 * them — `with-test-pg.mjs` probed 54322, named it "Supabase local stack" in the
 * line it printed, and exported the database URL alone. So the only test of
 * walrus anywhere skipped on the one machine in the world running walrus, and
 * CI could not cover for it either. `pnpm test:pg` shells out to that command
 * now and sets `AAI_REQUIRE_STACK`, so a dropped variable is red rather than
 * green — the anon key included: the leak control below is the only thing here
 * that can fail on a WORKING stream, so it is part of the stack this suite
 * needs rather than an optional extra it narrows itself around.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CloseableDb } from "@alexkroman1/aai-runtime";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { describeWithStack, pgUrl, stackEnv } from "./_pg-test-utils.ts";
import type { PlatformEvents } from "./platform-events.ts";
import { createRealtimePlatformEvents } from "./realtime-events.ts";

// `describeWithStack` IS the gate, and it is the ONLY one in this file. It is
// the conjunction — database plus `AAI_TEST_SUPABASE_URL` plus `_SERVICE_KEY`,
// resolved by `pnpm test:pg` rather than pasted by hand out of `supabase status
// -o env` — and it ANNOUNCES a skip, which a second hand-rolled
// `process.env.X ? describe : describe.skip` over the anon key did not. That
// one gated the leak control, i.e. the one assertion here that a working
// stream can fail, and it printed nothing and was covered by no
// `AAI_REQUIRE_*`: the day `supabase status -o env` stops naming `ANON_KEY`,
// the control would have disappeared under a green run. It is gone: the anon
// key is part of the gate's own conjunction now, so `stackEnv().anonKey` is a
// non-optional `string` past it and needs no second check of its own.

/** Realtime join + first frame, locally. Generous: the tier retries twice. */
const DELIVERY = { timeout: 15_000, interval: 50 } as const;

const migrationsDir = path.resolve(import.meta.dirname, "../../../supabase/migrations");

/**
 * The tables that carry RLS *now*, read from the migrations themselves.
 *
 * Parsed rather than listed so adding a table to a migration extends this suite
 * automatically. A hand-kept copy is the failure this repo has already paid for
 * elsewhere (the vitest project lists that drifted), and here it would drift
 * QUIETLY: a new table with RLS enabled and no coverage looks exactly like a new
 * table with coverage.
 *
 * **DROPS are subtracted, and that is not bookkeeping.** This reads every
 * migration in one pass, so without it the set is the union of every table that
 * ever existed — and the first retired one turns this case into
 * `<table> is missing — run \`supabase db push --local\``, which reads as a
 * developer with a stale stack rather than as a table that is gone on purpose.
 * No table has been dropped yet, so the subtraction is inert today — it stays
 * because the first drop must not read as a stale stack. `workflow_run_owner`
 * was expected to be the first and is not: the Workflow DevKit's schema is
 * RETIRED by rename rather than dropped (see `RETIRED_OBJECTS` in
 * `platform-schema.test.ts`), and that table is left in place entirely so a
 * rollback can still say whose rows those are.
 */
function rlsTables(): string[] {
  const files = readdirSync(migrationsDir)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const sql = files.map((n) => readFileSync(path.join(migrationsDir, n), "utf-8")).join("\n");
  const enabled = [
    ...sql.matchAll(/^alter table aai_platform\.(\w+) enable row level security;/gm),
  ].map((m) => m[1] as string);
  const dropped = new Set(
    [...sql.matchAll(/^drop table if exists aai_platform\.(\w+);/gm)].map((m) => m[1] as string),
  );
  // Code-unit, never `localeCompare`: with no explicit locale that answers to
  // the runtime's ICU default, so the same migrations would order differently on
  // another machine — the rule `API-EXPORTS.json` states for the same reason.
  return [...new Set(enabled)]
    .filter((table) => !dropped.has(table))
    .sort((a, b) => Number(a > b) - Number(a < b));
}

describeWithStack("the platform change stream survives RLS being enabled", () => {
  let db: CloseableDb;
  /** Every events client a test opened, closed in afterEach. */
  const opened: PlatformEvents[] = [];
  /** Agent slugs written by a test, deleted in afterEach. */
  const slugs: string[] = [];
  /** `[scope, project]` workspace keys written by a test. */
  const workspaces: [string, string][] = [];

  /** Unique per test, so a retry cannot collide with its own earlier attempt. */
  let unique = 0;
  const nextId = (): string => `rls-it-${process.pid}-${Date.now()}-${unique++}`;

  function events(key: string): PlatformEvents {
    const client = createRealtimePlatformEvents({ url: stackEnv().url, key });
    opened.push(client);
    return client;
  }

  /**
   * The anon key, for the leak control below.
   *
   * No check of its own: `describeWithStack`'s gate is the conjunction of the
   * database URL, the Supabase URL, the service key AND this one, so past the
   * gate `stackEnv().anonKey` is a non-optional `string`. A stack that resolved
   * three of the four never reaches here — it fails the gate, announced, and
   * `AAI_REQUIRE_STACK` turns that announcement into a red run.
   */
  function anonKey(): string {
    return stackEnv().anonKey;
  }

  async function insertAgent(slug: string): Promise<void> {
    slugs.push(slug);
    // No `config` column: `20260810030000_drop_agents_config.sql` dropped it (see
    // "The platform stores no agent config"). This insert named it — undetectably,
    // because the suite ran nowhere; the migrated stack rejects it outright.
    await db.query(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, $2::text::jsonb, $3, $4::text::jsonb, $5)`,
      [slug, "[]", "wh-1", "{}", 1],
    );
  }

  /** A fresh WAL record for an existing row. */
  async function bumpAgent(slug: string): Promise<void> {
    await db.query("update aai_platform.agents set version = version + 1 where slug = $1", [slug]);
  }

  async function insertWorkspace(scope: string, project: string): Promise<void> {
    workspaces.push([scope, project]);
    await db.query(
      `insert into aai_platform.studio_workspaces (scope, project, doc)
       values ($1, $2, $3::jsonb)`,
      [scope, project, JSON.stringify({ files: {} })],
    );
  }

  async function bumpWorkspace(scope: string, project: string): Promise<void> {
    await db.query(
      "update aai_platform.studio_workspaces set version = version + 1 where scope = $1 and project = $2",
      [scope, project],
    );
  }

  beforeAll(() => {
    db = createPostgresDb({ url: pgUrl(), max: 4 });
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((client) => client.close()));
    if (slugs.length > 0) {
      await db.query("delete from aai_platform.agents where slug = any($1)", [slugs.splice(0)]);
    }
    for (const [scope, project] of workspaces.splice(0)) {
      await db.query(
        "delete from aai_platform.studio_workspaces where scope = $1 and project = $2",
        [scope, project],
      );
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  /**
   * The precondition, and the reason none of the delivery tests can pass
   * vacuously: without it, a stack whose migrations were never applied would
   * show green streams and prove nothing about the migration under test.
   */
  test("the migration is actually applied to this stack", async () => {
    const expected = rlsTables();
    expect(expected.length).toBeGreaterThan(0);

    const rows = await db.query<{
      relname: string;
      rls: boolean;
      forced: boolean;
      policies: string;
    }>(
      `select c.relname,
              c.relrowsecurity as rls,
              c.relforcerowsecurity as forced,
              (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'aai_platform' and c.relkind = 'r'
        order by c.relname`,
    );
    const byName = new Map(rows.map((r) => [r.relname, r]));

    for (const table of expected) {
      const row = byName.get(table);
      expect(
        row,
        `aai_platform.${table} is missing — run \`supabase db push --local\``,
      ).toBeDefined();
      expect(row?.rls, `RLS is not enabled on ${table}`).toBe(true);
      // ENABLE, never FORCE: forcing applies policies to the table owner, and
      // the owner is every query the platform makes.
      expect(row?.forced, `RLS is FORCED on ${table}`).toBe(false);
      // A policy would be a claim that some non-owner role ought to read
      // these tables. None should.
      expect(Number(row?.policies), `${table} has policies`).toBe(0);
    }
  });

  test("service_role keeps its SELECT grant and no other role gains one", async () => {
    // Both halves are load-bearing for the streams below: Realtime validates
    // a channel's filter column against the columns the subscriber's role can
    // SELECT, so losing this grant kills filtered subscribes; gaining it for
    // `authenticated` is the mistake the RLS migration exists to contain.
    const [grants] = await db.query<Record<string, boolean>>(
      `select has_schema_privilege('service_role','aai_platform','usage') as sr_usage,
              has_table_privilege('service_role','aai_platform.agents','select') as sr_select,
              has_table_privilege('authenticated','aai_platform.agents','select') as auth_select,
              has_table_privilege('anon','aai_platform.agents','select') as anon_select`,
    );
    expect(grants).toEqual({
      sr_usage: true,
      sr_select: true,
      auth_select: false,
      anon_select: false,
    });
  });

  test("walrus still delivers agents changes to the service-role subscriber", async () => {
    const slug = nextId();
    const seen = vi.fn<(slug: string) => void>();
    events(stackEnv().serviceKey).watchAgents(seen);

    await insertAgent(slug);
    // The agents channel does not fire its watchers on SUBSCRIBED (only the
    // pooled, filtered channels do), so there is no join signal to wait on and
    // the insert above races the join. Re-bumping inside the poll is race-free
    // without reaching into `realtime.subscription`: every bump is a fresh WAL
    // record, and one delivery is all the claim needs.
    await vi.waitFor(async () => {
      await bumpAgent(slug);
      expect(seen).toHaveBeenCalledWith(slug);
    }, DELIVERY);
  });

  test("walrus still delivers on a FILTERED workspaces channel", async () => {
    // The filtered path is the one that dies on a missing grant, server-side,
    // with `invalid column for filter` — realtime-js then retries the join
    // forever and nothing downstream notices.
    const scope = nextId();
    const project = "demo";
    const changed = vi.fn();
    events(stackEnv().serviceKey).watchWorkspace(scope, project, changed);

    // A successful join fires the watchers by design (the join gap is
    // undeliverable, so every join owes a re-read). That makes the first call
    // the join signal — and proof the subscribe was ACKED, not merely sent.
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), DELIVERY);
    const afterJoin = changed.mock.calls.length;

    await insertWorkspace(scope, project);
    await vi.waitFor(async () => {
      await bumpWorkspace(scope, project);
      expect(changed.mock.calls.length).toBeGreaterThan(afterJoin);
    }, DELIVERY);
  });

  test("the scope-filtered projects channel delivers too", async () => {
    const scope = nextId();
    const changed = vi.fn();
    events(stackEnv().serviceKey).watchScopeProjects(scope, changed);

    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), DELIVERY);
    const afterJoin = changed.mock.calls.length;

    await insertWorkspace(scope, "sidebar");
    await vi.waitFor(async () => {
      await bumpWorkspace(scope, "sidebar");
      expect(changed.mock.calls.length).toBeGreaterThan(afterJoin);
    }, DELIVERY);
  });

  test("and it does not deliver to anyone else: an anon subscriber sees nothing", async () => {
    // What the migration BUYS, and the control that makes the tests above
    // non-vacuous. The two run against ONE write on ONE channel shape: a rig
    // that delivered nothing would fail the service-role assertion, and a
    // rig that delivered everything would fail this one. Neither can pass by
    // accident.
    //
    // Unfiltered on purpose — a filtered anon channel fires its watcher once
    // on join regardless of row visibility, so the absence of frames would
    // not be readable. Here, any call at all is a leak.
    const slug = nextId();
    const anonSaw = vi.fn<(slug: string) => void>();
    const serviceSaw = vi.fn<(slug: string) => void>();
    events(anonKey()).watchAgents(anonSaw);
    events(stackEnv().serviceKey).watchAgents(serviceSaw);

    await insertAgent(slug);
    // Delivery to service_role is the window: it proves the write really was
    // streamed while the anon subscriber was attached, so "anon got nothing"
    // is about visibility and not about not having waited long enough.
    await vi.waitFor(async () => {
      await bumpAgent(slug);
      expect(serviceSaw).toHaveBeenCalledWith(slug);
    }, DELIVERY);

    expect(anonSaw).not.toHaveBeenCalled();
  });
});
