// Copyright 2025 the AAI authors. MIT license.

import type { Image } from "modal";
import { afterEach, beforeEach, vi } from "vitest";
import { emptyLogPage } from "./agent-logs.ts";
import { createMemoryAgentRows } from "./agent-store.ts";
import { createMemoryBlobStorage } from "./blob-storage.ts";
import { createBundleStore } from "./bundle-store.ts";
import { type ChatStore, createMemoryChatStore } from "./chat-store.ts";
import { guestTokenFor } from "./guest-token.ts";
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
import type { AdminDb } from "./platform-lock.ts";
import type { Sandbox } from "./sandbox.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { type AgentSlot, createSlotCache } from "./sandbox-slots.ts";
import { createMemorySecretStore, type SecretStore, type SqlExec } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";
import type { AgentServerHandle } from "./warm-harness.ts";
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
 * An {@link AdminDb} whose reserved connection answers `respond`.
 *
 * The ONE narrowing between a spec's `(sql: string) => rows` responder and
 * `ReservedDb.query`, which is generic in its row type (`<T>(…) => Promise<T[]>`)
 * and so cannot be satisfied by a function returning one concrete shape. Both
 * wake-sweep suites had written `as never` at that boundary — the type-laundering
 * idiom the escape-hatch ratchet counts, and which stops reporting the moment
 * `ReservedDb` grows a member. A typed seam every call site goes through is what
 * this repo asks for instead of a cast per spec.
 *
 * `release` is a spy so a caller can assert the reservation was given back — a
 * leaked one permanently shrinks the real pool.
 *
 * **The responder sees the PARAMS as well as the SQL**, and it did not at first.
 * A responder keyed on the statement alone cannot answer differently for two rows
 * of the same table — so a suite asserting that one tenant's run is readable and
 * another's is not got the same answer for both, and its cross-tenant specs passed
 * against code that had no filter at all. Params are the only thing distinguishing
 * those two calls, so a seam that hides them cannot express the case it is most
 * often reached for.
 */
export function fakeAdminDbOver(
  respond: (
    sql: string,
    params?: unknown[],
  ) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>,
): AdminDb & { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn();
  const query = async <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => (await respond(sql, params)) as T[];
  return {
    release,
    reserve: () => Promise.resolve({ release, query }),
    // No-op, and callers that care about NOTIFY should say so: the queue sweep's
    // spec drives its listener by INVOKING the callback it captured, which needs
    // no Postgres. A fake that silently never notifies would make "the sweep
    // reacts to a notification" untestable rather than failing.
    listen: () => Promise.resolve(() => undefined),
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

/**
 * A resolved {@link AgentServerHandle}: a guest that booted, holds no sessions,
 * and answers every management call.
 *
 * The `spawnAgentServer` sibling of {@link fakeSandbox}, and there for the same
 * reason plus one more. Seven copies of this literal were spread over five
 * suites, all of them typed only by what `mockResolvedValue` would accept — so
 * three omitted `guestOrigin` (the field every guest surface is derived from)
 * and all seven omitted `logs`, and the type could grow a method without a
 * single spec noticing. Naming the return type is what makes the next field an
 * error here rather than a `TypeError` in whichever suite reaches it first.
 *
 * Overrides are spread last, so a spec that needs a busy or dead guest replaces
 * just `activeSessions`/`alive`.
 *
 * A suite that mocks `spawnAgentServer` arms this in a `beforeEach` rather than
 * in its `vi.hoisted` factory, because that factory runs BEFORE the module's
 * imports are initialized and cannot reach this function. Arming per test is
 * also stronger than a hoisted default: a plain `vi.fn()` is not a `vi.spyOn`
 * mock, so `restoreMocks` (vitest.shared.ts) never resets it, and one
 * `mockReset()` anywhere in a file left every LATER test running on whatever
 * the previous one happened to leave behind.
 */
export function spawnedAgent(overrides: Partial<AgentServerHandle> = {}): AgentServerHandle {
  return {
    sessionUrl: "wss://tunnel.test:443/websocket",
    guestOrigin: "wss://tunnel.test:443",
    activeSessions: vi.fn(() => Promise.resolve(0)),
    drain: vi.fn(() => Promise.resolve()),
    logs: vi.fn(() => Promise.resolve(emptyLogPage())),
    alive: () => true,
    onExit: vi.fn(),
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

/**
 * Deploy one agent as SETUP, and fail loudly when it does not land.
 *
 * The status check is the whole difference from {@link deploy}, which answers
 * the `Response` because its callers are asserting on it. Here the deploy is
 * arrangement for the assertion below it, so a 4xx has to surface as "deploy
 * mine answered 401" rather than as whatever the real test makes of a slug that
 * does not exist. Two tenancy suites had each written this helper locally, byte
 * for byte, for exactly that reason.
 */
export async function deployAgent(
  fetch: TestFetch,
  slug = "my-agent",
  key = "key1",
): Promise<void> {
  const res = await deploy(fetch, { key, body: { slug } });
  if (!res.ok) throw new Error(`deploy ${slug} answered ${res.status}`);
}

/**
 * The bearer `slug`'s running guest would present.
 *
 * The GUEST-side counterpart of {@link authHeaders}: those five platform routes
 * verify `HMAC(secret, agentSandboxName(slug, version))` rather than an API key
 * (`guest-bearer.ts`). Five suites had written this identically — the same reason
 * AGENTS.md gives for building a request with `authFetch` rather than a header
 * literal, on the other half of the surface.
 *
 * A missing agent falls back to version 1 so a suite can ask for the bearer of a
 * slug it has not deployed, which is what the 401/503 cases need.
 */
export async function bearerFor(
  store: { getAgentVersion(slug: string): Promise<number | null> },
  slug: string,
): Promise<string> {
  const version = (await store.getAgentVersion(slug)) ?? 1;
  return guestTokenFor(agentSandboxName(slug, version));
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
