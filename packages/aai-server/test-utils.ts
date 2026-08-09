// Copyright 2025 the AAI authors. MIT license.

import { createMemoryAgentRows } from "./agent-store.ts";
import { createMemoryBlobStorage } from "./blob-storage.ts";
import { createBundleStore } from "./bundle-store.ts";
import { type ChatStore, createMemoryChatStore } from "./chat-store.ts";
import { createOrchestrator } from "./orchestrator.ts";
import {
  createMemoryPlatformEvents,
  type MemoryPlatformEvents,
  type PlatformEvents,
  withAgentEvents,
  withChatEvents,
  withWorkspaceEvents,
} from "./platform-events.ts";
import { type AgentSlot, createSlotCache } from "./sandbox-slots.ts";
import { createMemorySecretStore, type SecretStore, type SqlExec } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "./workspace-store.ts";

// Deploys preflight the agent's required credentials against the merged env
// (see `missingCredentials` in deploy.ts); the default S2S test config needs
// the AssemblyAI key, so the standard test env carries one.
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

export function makeSlot(overrides?: Partial<AgentSlot>): AgentSlot {
  return {
    slug: "test-agent",
    ...overrides,
  };
}

export function deployBody(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
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
  });
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

export async function deployAgent(
  fetch: TestFetch,
  slug = "my-agent",
  key = "key1",
): Promise<void> {
  await fetch("/deploy", {
    method: "POST",
    headers: authHeaders(key),
    body: deployBody({ slug }),
  });
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
 * **It returns early on a database that already has the schema**, so pointing
 * the suite at the local Supabase stack, or at staging, runs no DDL at all.
 */
export async function ensurePlatformTables(sql: SqlExec): Promise<void> {
  // `SqlExec` is not generic — the row is `unknown`, which is all this needs.
  const [existing] = await sql(
    "select to_regclass('aai_platform.studio_workspaces') is not null as present",
  );
  if (existing?.present) return;

  const { readdirSync, readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const dir = path.resolve(import.meta.dirname, "../../supabase/migrations");
  const sqlText = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(path.join(dir, name), "utf-8"))
    .join("\n")
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
