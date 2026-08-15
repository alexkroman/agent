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
 * supabase start                     # applies supabase/migrations on init
 * supabase status -o env             # the values below
 *
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 * AAI_TEST_SUPABASE_URL='http://127.0.0.1:54321' \
 * AAI_TEST_SUPABASE_SERVICE_KEY='<SERVICE_ROLE_KEY>' \
 * AAI_TEST_SUPABASE_ANON_KEY='<ANON_KEY>' \
 *   pnpm --filter aai-server test:integration
 * ```
 *
 * Skips without those, like every other test in this tier. The anon key is
 * optional and only gates the negative control.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CloseableDb } from "@alexkroman1/aai/runtime";
import { createPostgresDb } from "@alexkroman1/aai/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { PG_URL, pgUrl } from "./_pg-test-utils.ts";
import type { PlatformEvents } from "./platform-events.ts";
import { createRealtimePlatformEvents } from "./realtime-events.ts";

const SB_URL = process.env.AAI_TEST_SUPABASE_URL;
const SB_SERVICE_KEY = process.env.AAI_TEST_SUPABASE_SERVICE_KEY;
const SB_ANON_KEY = process.env.AAI_TEST_SUPABASE_ANON_KEY;

// A CONJUNCTION, so it reads `PG_URL` rather than using `describeWithPg`: this
// suite needs the whole local Supabase stack, not only a database. The import
// still carries the loud skip and the AAI_REQUIRE_PG check for the PG half.
const describeIfStack = PG_URL && SB_URL && SB_SERVICE_KEY ? describe : describe.skip;
const describeIfAnon = SB_ANON_KEY ? describe : describe.skip;

/** Realtime join + first frame, locally. Generous: the tier retries twice. */
const DELIVERY = { timeout: 15_000, interval: 50 } as const;

const migrationsDir = path.resolve(import.meta.dirname, "../../supabase/migrations");

/**
 * The tables the RLS migration names, read from the migration itself.
 *
 * Parsed rather than listed so adding a table to the migration extends this
 * suite automatically. A hand-kept copy is the failure this repo has already
 * paid for elsewhere (the vitest project lists that drifted), and here it
 * would drift QUIETLY: a new table with RLS enabled and no coverage looks
 * exactly like a new table with coverage.
 */
function rlsTables(): string[] {
  const files = readdirSync(migrationsDir)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const sql = files.map((n) => readFileSync(path.join(migrationsDir, n), "utf-8")).join("\n");
  const tables = [
    ...sql.matchAll(/^alter table aai_platform\.(\w+) enable row level security;/gm),
  ].map((m) => m[1] as string);
  return [...new Set(tables)].sort();
}

describeIfStack("the platform change stream survives RLS being enabled", () => {
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
    const client = createRealtimePlatformEvents({ url: SB_URL as string, key });
    opened.push(client);
    return client;
  }

  async function insertAgent(slug: string): Promise<void> {
    slugs.push(slug);
    await db.query(
      `insert into aai_platform.agents
         (slug, credential_hashes, config, worker_hash, client_files, version)
       values ($1, $2::jsonb, $3::jsonb, $4, $5::jsonb, $6)`,
      [slug, "[]", JSON.stringify({ name: slug }), "wh-1", "{}", 1],
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
    events(SB_SERVICE_KEY as string).watchAgents(seen);

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
    events(SB_SERVICE_KEY as string).watchWorkspace(scope, project, changed);

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
    events(SB_SERVICE_KEY as string).watchScopeProjects(scope, changed);

    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), DELIVERY);
    const afterJoin = changed.mock.calls.length;

    await insertWorkspace(scope, "sidebar");
    await vi.waitFor(async () => {
      await bumpWorkspace(scope, "sidebar");
      expect(changed.mock.calls.length).toBeGreaterThan(afterJoin);
    }, DELIVERY);
  });

  // Gated on the nested `describe` rather than with `test.runIf`, so the
  // assertions stay inside a literal `test(` call — Biome's
  // `noMisplacedAssertion` does not see through `test.runIf(x)(…)`, and
  // suppressing it inline would be a net-new escape hatch (see the root
  // CLAUDE.md; `check:hatches` matches plain substrings, so even NAMING the
  // suppression here would score as one).
  describeIfAnon("and it does not deliver to anyone else", () => {
    test("an anon subscriber sees nothing on the same change", async () => {
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
      events(SB_ANON_KEY as string).watchAgents(anonSaw);
      events(SB_SERVICE_KEY as string).watchAgents(serviceSaw);

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
});
