// Copyright 2025 the AAI authors. MIT license.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Image } from "modal";
import { afterEach, beforeEach, vi } from "vitest";
import { emptyLogPage } from "./agent-logs.ts";
import { createMemoryAgentRows } from "./agent-store.ts";
import { type AppDatabases, appDbIdentifier } from "./app-database.ts";
import type { DatabaseAdmin } from "./app-db-admin.ts";
import { createMemoryBlobStorage } from "./blob-storage.ts";
import { createBundleStore } from "./bundle-store.ts";
import { type ChatStore, createMemoryChatStore } from "./chat-store.ts";
import { type Logger, type RecordedLine, recordingSink, setLogSink } from "./logger.ts";
import { createOrchestrator } from "./orchestrator.ts";
import {
  createMemoryPlatformEvents,
  type MemoryPlatformEvents,
  type PlatformEvents,
  withAgentEvents,
  withChatEvents,
  withWorkspaceEvents,
} from "./platform-events.ts";
import type { Sandbox } from "./sandbox.ts";
import { type AgentSlot, createSlotCache } from "./sandbox-slots.ts";
import { createMemorySecretStore, type SecretStore, type SqlExec } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "./workspace-store.ts";

/**
 * The real-Postgres and Supabase-stack gates, re-exported so a SIBLING package
 * can reach them.
 *
 * They live in `_pg-test-utils.ts`, and the underscore is what makes them
 * unreachable across a package boundary (Biome's `noPrivateImports`) — which is
 * exactly why `session-state.scenario.test.ts` hand-rolled its own copy of the
 * gate. `aai-studio-server` owns two store contracts (the session registry and
 * the preview queue) whose stack arm needs the same one spelling, and a second
 * copy of a gate is how a gate stops agreeing with itself. `./test-utils` is
 * already this package's published-to-siblings test surface, so it is the seam.
 *
 * Only what a sibling really uses is re-exported — `describeWithPg` and
 * `stackEnv` stay behind the underscore, because knip reports an unused export
 * here and a re-export nobody needs is exactly that.
 */
export { describeWithStack, pgUrl } from "./_pg-test-utils.ts";

// The default test worker is an S2S config, which resolves its provider
// credential from `ASSEMBLYAI_API_KEY` — so the standard test env carries one
// and a deployed agent built from this payload can actually open a session.
//
// (The comment here used to point at `missingCredentials` in `deploy.ts`. That
// function is the CLI's, it lives in `aai-cli/_preflight.ts`, and it WARNS
// rather than gating — the platform runs no such preflight, because it cannot
// see what `aai secret put` already stored server-side.)
export const VALID_ENV: Record<string, string> = { ASSEMBLYAI_API_KEY: "test-key" };

/**
 * In-memory BundleStore for tests: the REAL bundle store over the in-memory
 * blob storage, in-memory agent rows, and an in-memory SecretStore — so
 * tests exercise the same content-addressed blob + row-commit code paths
 * production runs. When a SecretStore is passed, `deleteAgent` sweeps the
 * agent's secret names like production does (the delete route relies on
 * that contract).
 */
export function createTestStore(secrets?: SecretStore, events?: MemoryPlatformEvents): BundleStore {
  const agents = createMemoryAgentRows();
  return createBundleStore(createMemoryBlobStorage(), {
    secrets: secrets ?? createMemorySecretStore(),
    // Paired with a memory event bus when given, so agents-row writes notify
    // watchers exactly like production's postgres_changes stream.
    agents: events ? withAgentEvents(agents, events.emitAgent) : agents,
  });
}

/**
 * An inert {@link AppDatabases}, with only the methods a spec cares about
 * overridden.
 *
 * The five-method surface was hand-built as an object literal in four specs
 * (`delete`, `sandbox-resolve`, `storage-handler`, `app-database`), so ADDING a
 * method broke all four at once while telling us nothing — which is what
 * `withAppDb` did when per-app databases arrived. That is the typed-seam case
 * this repo argues for: one narrowing every call site goes through, rather than a
 * literal repeated per spec.
 *
 * Every default is deliberately inert and LOUD rather than plausible: a spec that
 * reaches a method it did not stub is a spec whose subject did something
 * unexpected, and returning a cheerful empty value hides exactly that. `provision`
 * is the one exception — it returns a well-formed meta, because several specs need
 * a provision to succeed without caring what it produced.
 */
export function fakeAppDatabases(overrides?: Partial<AppDatabases>): AppDatabases {
  const unstubbed = (name: string) => (): never => {
    throw new Error(`fakeAppDatabases: ${name} was called but not stubbed`);
  };
  return {
    provision: async (slug) => ({ role: appDbIdentifier(slug), password: "0".repeat(32) }),
    deprovision: async () => undefined,
    connectionUrl: unstubbed("connectionUrl"),
    usage: unstubbed("usage"),
    withAppDb: unstubbed("withAppDb"),
    ...overrides,
  };
}

/**
 * A recording {@link DatabaseAdmin} — the Management API channel `create
 * database` / `drop database` go out on, without speaking HTTP.
 *
 * There is no SQL implementation of that channel any more (see
 * `app-db-admin.ts`), so every caller of `provisionAppDatabase` /
 * `deprovisionAppDatabase` / `createAppDatabases` has to pass one, and a spec
 * asserting WHICH CLUSTER a drop landed on now reads it here rather than out of
 * the recorded SQL. `created`/`dropped` hold the identifiers in call order.
 */
export function fakeDatabaseAdmin(ref = "testreftestreftestre"): DatabaseAdmin & {
  created: string[];
  dropped: string[];
} {
  const created: string[] = [];
  const dropped: string[] = [];
  return {
    ref,
    created,
    dropped,
    createDatabase: async (id) => {
      created.push(id);
    },
    dropDatabase: async (id) => {
      dropped.push(id);
    },
  };
}

/**
 * A live fake {@link Sandbox} — resolved URLs on the standard test tunnel, and
 * every lifecycle method a no-op spy.
 *
 * The same five-method literal had been written out in FOUR specs (the phone
 * webhook, both workflow proxies, and the transport/upgrade suite), byte for
 * byte apart from whether it took `overrides`. That is the case this file's
 * `fakeAppDatabases` already argues: `Sandbox` growing a method breaks every
 * copy at once while telling nobody which behaviour the specs actually wanted.
 *
 * Overrides are spread last, so a spec that needs a sandbox stuck on boot
 * replaces just `sessionUrl`/`guestOrigin`.
 */
export function fakeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    sessionUrl: vi.fn(() => Promise.resolve("wss://tunnel.test:443/websocket")),
    guestOrigin: vi.fn(() => Promise.resolve("wss://tunnel.test:443")),
    drain: vi.fn(() => Promise.resolve()),
    logs: vi.fn(() => Promise.resolve(emptyLogPage())),
    alive: vi.fn(() => true),
    shutdown: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

export function makeSlot(overrides?: Partial<AgentSlot>): AgentSlot {
  return {
    slug: "test-agent",
    ...overrides,
  };
}

/** The default deploy payload as an OBJECT, for callers that re-encode it. */
export function deployPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    env: VALID_ENV,
    worker:
      'export default { name: "test-agent", systemPrompt: "Test", greeting: "", maxSteps: 1, tools: {} };',
    clientFiles: {
      "index.html":
        // biome-ignore lint/security/noSecrets: HTML template, not a secret
        '<!DOCTYPE html><html><body><script type="module" src="./assets/index.js"></script></body></html>',
      "assets/index.js": 'console.log("c");',
    },
    ...overrides,
  };
}

export function deployBody(overrides?: Record<string, unknown>): string {
  return JSON.stringify(deployPayload(overrides));
}

export type TestFetch = (input: string | Request, init?: RequestInit) => Promise<Response>;

export async function createTestOrchestrator(
  overrides: Partial<Parameters<typeof createOrchestrator>[0]> = {},
): Promise<{
  fetch: TestFetch;
  store: BundleStore;
  workspaces: WorkspaceStore;
  chats: ChatStore;
  events: PlatformEvents;
}> {
  // Stores + event bus are a PAIR (see platform-events.ts): the
  // orchestrator's event-driven sandbox invalidation and the studio's SSE
  // pushes only fire when row writes emit.
  const memoryEvents = createMemoryPlatformEvents();
  const store = createTestStore(overrides.secrets, memoryEvents);
  const workspaces = withWorkspaceEvents(createMemoryWorkspaceStore(), memoryEvents.emitWorkspace);
  const chats = withChatEvents(createMemoryChatStore(), memoryEvents.emitChat);
  const { app } = createOrchestrator({
    slots: createSlotCache(),
    store,
    events: memoryEvents.events,
    ...overrides,
  });
  const fetch: TestFetch = async (input, init) => app.request(input, init);
  return { fetch, store, workspaces, chats, events: memoryEvents.events };
}

/** Standard auth + JSON headers for test requests. */
export function authHeaders(key = "key1"): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

/** Convenience: authenticated JSON request via test fetch. */
export async function authFetch(
  fetch: TestFetch,
  path: string,
  opts: { method?: string; key?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(path, {
    method: opts.method ?? "POST",
    headers: authHeaders(opts.key),
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/**
 * Convenience: authenticated `POST /deploy` carrying the standard test body,
 * returning the response.
 *
 * This is the shape almost every deploy-route spec wants, and spelling it out
 * per call site is what let ~40 of them drift apart on the details that are
 * not the subject of the test (the method, the JSON content type, whether the
 * body was encoded once or twice). Use {@link deployAgent} when the response
 * does not matter, and drop to a bare `fetch` only when the REQUEST itself is
 * what a spec is exercising — a missing header, a gzipped body, a raw string.
 */
export async function deploy(
  fetch: TestFetch,
  opts: { key?: string; body?: Record<string, unknown> } = {},
): Promise<Response> {
  return authFetch(fetch, "/deploy", { ...opts, body: deployPayload(opts.body) });
}

export async function deployAgent(
  fetch: TestFetch,
  slug = "my-agent",
  key = "key1",
): Promise<void> {
  await deploy(fetch, { key, body: { slug } });
}

// ── SqlExec fakes ────────────────────────────────────────────────────────────

/** One statement's behaviour in a {@link createDispatchingSql} fake. */
export type SqlHandler = (params: unknown[]) => Record<string, unknown>[];

/** A statement issued against a fake `SqlExec`, in the order it was issued. */
export type SqlCall = { query: string; params: unknown[] };

/**
 * A fake `SqlExec` that dispatches each statement to the FIRST handler whose
 * prefix matches, logging every call for shape assertions.
 *
 * Matching is on the whitespace-collapsed, lower-cased statement, so handler
 * prefixes read like the SQL they stand for. Order matters where one prefix
 * extends another — the workspace store's metadata patch and its versioned
 * update both begin `update <table> set doc =`, so the longer prefix has to
 * be listed first. An unmatched statement REJECTS rather than returning `[]`:
 * a store that grows a statement its fake does not model must fail loudly,
 * not read as an empty result set.
 */
export function createDispatchingSql(handlers: readonly [string, SqlHandler][]): {
  sql: SqlExec;
  log: SqlCall[];
} {
  const log: SqlCall[] = [];
  const sql: SqlExec = (query, params = []) => {
    log.push({ query, params });
    const q = query.replace(/\s+/g, " ").trim().toLowerCase();
    const handler = handlers.find(([prefix]) => q.startsWith(prefix))?.[1];
    if (!handler) return Promise.reject(new Error(`Unexpected query: ${query}`));
    try {
      return Promise.resolve(handler(params));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  return { sql, log };
}

/**
 * A DDL handler that refuses its first `failures` calls, then succeeds — for
 * the stores' "a failed `create table` must not wedge the store" specs.
 */
export function refusingDdl(failures = 0): SqlHandler {
  let remaining = failures;
  return () => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error("ddl refused");
    }
    return [];
  };
}

/**
 * A fake `SqlExec` that records every statement and answers from one
 * `respond` function — for stores whose specs assert on the statements
 * issued rather than on state accumulated across them.
 */
export function createRecordingSql(
  respond: (query: string, params: unknown[]) => Record<string, unknown>[] = () => [],
): { sql: SqlExec; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const sql: SqlExec = (query, params = []) => {
    calls.push({ query, params });
    return Promise.resolve(respond(query, params));
  };
  return { sql, calls };
}

/**
 * Create the `aai_platform` tables on the database under test, if it has none.
 *
 * The integration tier's Postgres is the CI runner's own cluster
 * (`.github/workflows/check.yml` starts it), which carries no `aai_platform`
 * schema. That was fine while the only suites needing a database were
 * `platform-lock` (advisory locks need no schema) and `schema-drift` (it reads
 * `pg_class`, and an empty schema satisfies "every table present is declared"
 * vacuously). A suite that reads and writes real rows needs the tables.
 *
 * **The DDL is EXTRACTED from `supabase/migrations`, never restated here.** A
 * hand-copy of a schema in a test util is the same class of bug as the one
 * these suites exist to catch: it passes forever against a shape production
 * does not have. The extraction is deliberately partial — `create table` plus
 * column-level `alter table` — because the migrations also install `pg_cron`
 * and `pgmq`, and neither extension exists on a stock cluster. Nothing here
 * needs them.
 *
 * **The `alter table` half is what keeps a create-table-only replay from
 * drifting into fiction.** A column added or dropped after its table's
 * migration exists only in an `alter`, so replaying the creates alone builds
 * the schema as it stood on day one: `agents.config` back from the dead (NOT
 * NULL, and no store writes it any more) and no `studio_workspaces.
 * preview_slug` for the orphan-preview sweep to join on. Only `add column` /
 * `drop column` are replayed — constraint and index DDL lives inside `do $$`
 * blocks that a statement-level regex cannot safely split, and no suite here
 * depends on one.
 *
 * **On a CLI-built database it VERIFIES instead of assuming.** This used to
 * return early whenever `aai_platform` existed at all, so pointing the suite at
 * the local Supabase stack or at staging ran no DDL — and asserted nothing about
 * the schema being CURRENT, only that *some* `aai_platform` was there. That is
 * not hypothetical: the stack on this machine held three of nine migrations
 * (`supabase start` applies them on INIT and nothing since had run
 * `migration up`), so a suite died on `column w.preview_slug does not exist` —
 * a `PostgresError` naming a column, whose first reading is "the code is
 * broken". `supabase_migrations.schema_migrations` is an exact oracle for it,
 * and cheaper than a column comparison: when the CLI built this database its own
 * ledger says what it applied, so the check is a set difference against
 * `readdirSync(supabase/migrations)` and the failure names the pending files and
 * the command that applies them. When there is no ledger the database was built
 * by this helper's own DDL, and the replay below is right — which also makes
 * that replay (a THIRD thing that applies this schema, after `supabase db push`
 * and `supabase start`) honest about which of the three it is looking at.
 *
 * CI is unaffected either way: a fresh container per run cannot drift.
 */
/**
 * The repo's migration files, sorted, plus their concatenated text.
 *
 * Both readers below (the DDL replay and {@link platformMigrationSql}) had
 * written the same listing, the same `.sql` filter, the same sort and the same
 * join — and only one of them refused an empty directory, which is the one
 * outcome that makes either of them silently do nothing.
 */
function readMigrations(): { dir: string; files: string[]; raw: string } {
  const dir = path.resolve(import.meta.dirname, "../../supabase/migrations");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no migrations in ${dir}`);
  return { dir, files, raw: files.map((n) => readFileSync(path.join(dir, n), "utf-8")).join("\n") };
}

export async function ensurePlatformTables(sql: SqlExec): Promise<void> {
  const { dir, files: repoMigrations, raw } = readMigrations();

  // `SqlExec` is not generic — the row is `unknown`, which is all this needs.
  const [ledger] = await sql(
    "select to_regclass('supabase_migrations.schema_migrations') is not null as present",
  );
  if (ledger?.present) {
    await assertMigrationsApplied(sql, repoMigrations);
    return;
  }

  const [existing] = await sql(
    "select to_regclass('aai_platform.studio_workspaces') is not null as present",
  );
  if (existing?.present) return;

  const sqlText = raw
    // COMMENTS FIRST, or prose becomes DDL. These migrations explain
    // themselves at length and quote statements while doing it — the expand
    // half of the `agents.config` retirement names its own contract half
    // (`alter table … drop column config;`) in a comment, which this happily
    // executed: a `drop` with no `if exists`, extracted from a sentence.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");

  // The migrations format every table as `create table … (` … `\n);`, which is
  // what makes a regex safe despite the `primary key (a, b)` lines inside.
  const tables = sqlText.match(/create table if not exists aai_platform\.\w+ \([\s\S]*?\n\);/g);
  // Loud rather than vacuous: a reformatted migration must fail here, not
  // produce a suite that silently creates nothing and errors row by row.
  if (!tables || tables.length === 0) {
    throw new Error(`no create-table statements found in ${dir} — has the format changed?`);
  }
  await sql("create schema if not exists aai_platform");
  for (const statement of tables) await sql(statement);

  // Applied in migration order (the file sort above), so a column added and
  // later dropped ends up dropped. Every one is `if [not] exists`, so this is
  // as re-runnable as the creates.
  const columns =
    sqlText.match(/alter table\s+aai_platform\.\w+\s+(?:add|drop) column[\s\S]*?;/g) ?? [];
  for (const statement of columns) await sql(statement);

  const [created] = await sql(
    "select to_regclass('aai_platform.studio_workspaces') is not null as present",
  );
  if (!created?.present) throw new Error("aai_platform tables were not created");
}

/**
 * The migrations as they ship, minus the one line a throwaway database cannot
 * run — with the omission COUNTED.
 *
 * pg_cron is single-database by design: its background worker reads job
 * descriptions from `cron.database_name` (`postgres`), so `create extension
 * pg_cron` anywhere else raises `can only create extension in database
 * postgres`. Everything else executes verbatim against the real extensions.
 *
 * This is not the `create extension`-stripping regex that used to live in
 * `platform-schema.scenario.test.ts`. That one removed THREE lines, because the
 * arm was a stock server on which none of the Supabase extensions could be
 * installed, and it came with a hand-written plpgsql `pgmq.create` stub — a
 * fourth implementation of a contract, in SQL. Both are gone; the stack has the
 * real extensions, and what is left is one structural property of pg_cron.
 *
 * Note `supabase_vault` is created by NO migration (Supabase pre-installs it), so
 * a database built from these files alone has no Vault. A caller that needs it —
 * anything touching `vault.secrets`, which includes the orphan-preview sweep —
 * must create it itself.
 */
export function platformMigrationSql(): { sql: string; skipped: number } {
  const { raw } = readMigrations();
  let skipped = 0;
  const sql = raw.replace(/^create extension if not exists pg_cron;$/gm, () => {
    skipped += 1;
    return "-- pg_cron omitted: single-database extension, pinned to cron.database_name";
  });
  return { sql, skipped };
}

/**
 * A migration filename's version — the digits the Supabase CLI records.
 *
 * `20260810020000_preview_slug_column.sql` → `20260810020000`. Exported because
 * `store-conformance.ts` reports the same set and must agree on the reading.
 */
export function migrationVersion(filename: string): string {
  return /^(\d+)/.exec(filename)?.[1] ?? filename;
}

/**
 * Fail naming the pending migrations, when the CLI's ledger is behind the repo.
 *
 * The failure a stale database actually produces is a `PostgresError` about a
 * column, several suites deep, which reads as a code bug — so this trades it for
 * one sentence naming the files and the command. Deliberately does NOT apply
 * them: a fixture that migrates the developer's stack would be a FOURTH thing
 * that applies this schema, and it would do it to a database the developer may
 * have data in. Fail with the exact command; that is the only outcome that
 * cannot surprise anybody.
 */
async function assertMigrationsApplied(sql: SqlExec, repoMigrations: string[]): Promise<void> {
  const rows = await sql("select version from supabase_migrations.schema_migrations");
  const applied = new Set(rows.map((row) => String(row.version)));
  const pending = repoMigrations.filter((name) => !applied.has(migrationVersion(name)));
  if (pending.length === 0) return;
  throw new Error(
    `This database was built by the Supabase CLI and is ${pending.length} migration(s) ` +
      `behind supabase/migrations:\n\n${pending.map((n) => `  ${n}`).join("\n")}\n\n` +
      "Apply them, then re-run:\n\n  supabase migration up      # keeps the data in it\n" +
      "  supabase db reset          # rebuilds from every migration, discarding it\n\n" +
      "(Nothing here applies them for you: a fixture that migrated your own stack " +
      "would be a fourth thing that applies this schema, to a database you may have " +
      "data in.)",
  );
}

/**
 * Silence this package's log output for the current file, and record it.
 *
 * The replacement for `spyOn(console, "warn")`, which was how 39 specs kept
 * their output quiet before there was a seam to swap (see `logger.ts`). Call it
 * at describe scope; it installs the recording sink in `beforeEach` and
 * restores in `afterEach`, so a spec asserts on `logs.warns()` rather than on a
 * spy it also had to remember to silence.
 *
 * Asserting on the TEXT is deliberately awkward — `warns()` returns the
 * namespace-prefixed messages, and most callers should ask only whether a line
 * was written. A spec that pins exact wording locks the message rather than the
 * behaviour, and every one of the 25 lines this replaced had been reworded at
 * least once without its spec noticing.
 */
export function captureLogs(): {
  /** Every line written since the current test began. */
  all(): RecordedLine[];
  /** Messages written at `warn`. */
  warns(): string[];
  /** Messages written at `error`. */
  errors(): string[];
  /** Messages written at `info`. */
  infos(): string[];
} {
  let recorded: { sink: Logger; lines: RecordedLine[] } = recordingSink();
  let restore: (() => void) | undefined;
  beforeEach(() => {
    recorded = recordingSink();
    restore = setLogSink(recorded.sink);
  });
  afterEach(() => {
    restore?.();
  });
  const at = (level: RecordedLine["level"]) => () =>
    recorded.lines.filter((l) => l.level === level).map((l) => l.msg);
  return {
    all: () => recorded.lines,
    warns: at("warn"),
    errors: at("error"),
    infos: at("info"),
  };
}

/**
 * A Modal `Image` double that records every layer's commands, in order.
 *
 * The one cast for this shape in the package: `Image` is a class with private
 * fields, so a structural stand-in cannot satisfy it, and the fake was written
 * twice with the cast spelled out at each site. Narrowing once here is the same
 * typed-seam rule the root guide states for a concentration of identical casts.
 */
export function fakeModalImage(): Image & { commands: string[][] } {
  const commands: string[][] = [];
  const image = {
    commands,
    dockerfileCommands(next: string[]) {
      commands.push(next);
      return image;
    },
  } as unknown as Image & { commands: string[][] };
  return image;
}
