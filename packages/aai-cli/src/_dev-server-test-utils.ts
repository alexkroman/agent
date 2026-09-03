// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared mock scaffolding for the _dev-server test files.
 *
 * `_dev-server.test.ts` and `_dev-server-restart.test.ts` used to carry a
 * verbatim ~120-line copy of this each — the chokidar fake in particular is
 * subtle enough to want exactly one copy.
 *
 * Usage: each test file keeps its own `vi.mock(...)` calls (they must be
 * top-level in the test file for vitest's hoisting), but every factory is a
 * one-liner that pulls the module shape from here:
 *
 *   vi.mock("chokidar", async () =>
 *     (await import("./_dev-server-test-utils.ts")).chokidarModule());
 *
 * Vitest isolates the module registry per test file, so each file gets its
 * own instances of the mock fns and `chokidarState` — no cross-file state.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { linkSdkNodeModules, makeMockLog } from "./_test-utils.ts";

// ─── Fixture project ─────────────────────────────────────────────────────────

/**
 * Write a minimal `agent.ts` in `dir`, with the SDK resolvable from it.
 *
 * Both dev-server suites need exactly this, and they each had a copy — one of
 * which hand-rolled the symlink and swallowed EVERY error from it, so a real
 * failure surfaced as a module-resolution error several layers away instead of
 * naming the link. `linkSdkNodeModules` is the version that only forgives
 * EEXIST.
 */
export async function writeAgentTs(dir: string, name = "test-agent"): Promise<void> {
  await linkSdkNodeModules(dir);
  await fs.writeFile(
    path.join(dir, "agent.ts"),
    `export default { name: "${name}", tools: {} };\n`,
  );
}

// ─── Mock fns ────────────────────────────────────────────────────────────────

export const mockListen = vi.fn();
export const mockClose = vi.fn();
export const mockCreateRuntime = vi.fn();
export const mockCreateServer = vi.fn();
// The runtime barrel is mocked to keep it out of these specs, so this stands
// in for the real registry-derived lookup. The provider-less agent these
// tests write runs the default AssemblyAI pipeline, which needs an AssemblyAI
// key; the real function has its own specs in the aai package
// (providers/resolve.test.ts).
const mockRequiredProviderEnvVars = vi.fn();
export const mockEnsureApiKey = vi.fn();
export const mockResolveServerEnv = vi.fn();
/**
 * The session-state DDL the dev server applies when the project declares a
 * `DATABASE_URL`. A mock rather than the real thing because the real one opens a
 * Postgres pool, which is what the tier rules put in `test:scenario`.
 */
export const mockEnsureSessionStateSchema = vi.fn();
/** The JOURNAL's DDL, public for the same reason and applied on the same boot. */
export const mockEnsureWorkflowJournalSchema = vi.fn();
export const mockValidateAgentExport = vi.fn();
/**
 * The process-scoped run journal `startDevServer` builds once and hands every
 * rebuild's `createRuntime`.
 *
 * A FRESH object per call deliberately, which is what makes the identity
 * assertion in `_dev-server-restart.test.ts` mean something: called per build,
 * every rebuild would hand out a different store and a run started before a save
 * would be unreadable after it — the bug the seam exists to close.
 */
export const mockCreateMemoryJournal = vi.fn(() => ({ journal: "memory" }));

/**
 * The env key the dev server writes the project's `.workflow-data` into.
 *
 * Spelled out rather than imported for the reason `WORKFLOW_API_PREFIX` below
 * is: this module IS the factory for the `vi.mock("@alexkroman1/aai-runtime/
 * internal")` call. That it still matches the SDK's own constant is asserted in
 * `_dev-server-serve.test.ts`, which mocks nothing.
 */
export const WORKFLOW_DATA_DIR_ENV_LITERAL = "AAI_WORKFLOW_DATA_DIR";

/**
 * The default implementations, in ONE place.
 *
 * They used to be written twice — once as `vi.fn().mockResolvedValue(…)`
 * initializers and again inside `primeDevServerMocks` — so a default changed at
 * the declaration was silently overridden from the first `beforeEach` onwards,
 * and the two copies were free to disagree about what a mock returns.
 */
function primeDefaults(): void {
  mockListen.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockCreateRuntime.mockReturnValue({ runtime: "mock" });
  mockCreateServer.mockReturnValue({ listen: mockListen, close: mockClose });
  mockRequiredProviderEnvVars.mockReturnValue(["ASSEMBLYAI_API_KEY"]);
  mockEnsureApiKey.mockResolvedValue("test-api-key");
  mockResolveServerEnv.mockResolvedValue({ ASSEMBLYAI_API_KEY: "test-key" });
}

primeDefaults();

/**
 * Reset the shared mocks to a known state: CALL HISTORY CLEARED, then the
 * default implementations re-primed. Call it from `beforeEach` (both files
 * already do).
 *
 * The history half is the load-bearing one and it is this function's job, not
 * the runner's. `restoreMocks: true` registers only `vi.spyOn` mocks — it
 * touches neither the call history nor the implementation of a plain
 * `vi.fn()`, so without the `mockClear()` below every one of these mocks
 * accumulates calls for the whole FILE. An
 * `expect(mockListen).toHaveBeenCalledWith(3000, undefined)` is then satisfied
 * by any earlier test that happened to listen on 3000, which is a statement
 * about file order rather than about the case under test. (This comment used
 * to claim `restoreMocks` did the wiping; it does not, and the tests that
 * believed it were passing on their predecessors' calls.)
 */
export function primeDevServerMocks(): void {
  // Read lazily rather than from a module-scope array: `mockChokidarWatch` is
  // declared below this function, so an eager list would be evaluated inside
  // its temporal dead zone.
  for (const mock of [
    mockListen,
    mockClose,
    mockCreateRuntime,
    mockCreateServer,
    mockRequiredProviderEnvVars,
    mockEnsureApiKey,
    mockResolveServerEnv,
    mockEnsureSessionStateSchema,
    mockEnsureWorkflowJournalSchema,
    mockValidateAgentExport,
    mockCreateMemoryJournal,
    mockChokidarWatch,
  ]) {
    mock.mockClear();
  }
  primeDefaults();
}

// ─── Fake chokidar ───────────────────────────────────────────────────────────
// Captures the watched dir, the `ignored` matcher, and the "all"/"error"
// event callbacks so tests can fire synthetic change events.

export const chokidarState = {
  allCallback: undefined as ((event: string, filePath: string) => void) | undefined,
  errorCallback: undefined as ((err: unknown) => void) | undefined,
  ignored: undefined as ((filePath: string) => boolean) | undefined,
  close: vi.fn().mockResolvedValue(undefined),
  watchedDir: undefined as string | undefined,
};

export const mockChokidarWatch = vi.fn(
  (dir: string, opts: { ignored?: (filePath: string) => boolean }) => {
    chokidarState.watchedDir = dir;
    chokidarState.ignored = opts.ignored;
    return {
      on: (event: string, cb: (event: string, filePath: string) => void) => {
        if (event === "all") chokidarState.allCallback = cb;
        if (event === "error") chokidarState.errorCallback = cb as (err: unknown) => void;
      },
      close: chokidarState.close,
    };
  },
);

// ─── Module-shape factories for vi.mock ──────────────────────────────────────

export async function nodeFsModule(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
}

export function chokidarModule(): Record<string, unknown> {
  return { watch: mockChokidarWatch };
}

/** Deterministic port selection: always return the first candidate port. */
export async function getPortModule(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<typeof import("get-port")>("get-port");
  return {
    ...actual,
    default: vi.fn(async (opts?: { port?: Iterable<number> }) => {
      const first = opts?.port?.[Symbol.iterator]().next().value;
      return first ?? 0;
    }),
  };
}

export function aaiRuntimeModule(): Record<string, unknown> {
  return {
    createRuntime: mockCreateRuntime,
    createServer: mockCreateServer,
    requiredProviderEnvVars: mockRequiredProviderEnvVars,
    // The dev server applies the self-hosted credential fallback when building
    // `env`; identity here keeps these tests focused on wiring. The helper's
    // own behavior is covered in aai/host/providers/host-env.test.ts.
    withHostCredentialFallback: (env: Record<string, string>) => env,
    // `viteDevConfig` uses this as a proxy KEY, so it has to be a string here
    // or the config these specs build has a hole in it. Spelled out rather
    // than imported: this module IS the factory for the
    // `vi.mock("@alexkroman1/aai-runtime")` call, so importing the real barrel
    // here is a mock importing the module it mocks — which hangs the run
    // rather than failing it. That the literal still matches the SDK is
    // asserted in `_dev-server-serve.test.ts`, which does not mock the barrel.
    WORKFLOW_API_PREFIX: "/workflows",
    // `viteDevConfig` binds Vite to the same loopback the backend does, rather
    // than to Vite's own `localhost` DEFAULT — which resolves to `::1` first on
    // macOS, leaving the port `aai dev` prints unreachable at the IPv4 literal.
    // Spelled out here for the same reason the prefix above is, and pinned
    // against the real constant by `_dev-server-serve.test.ts`.
    DEFAULT_LISTEN_HOST: "127.0.0.1",
    // Applied once at boot when the project declares a `DATABASE_URL`. It was
    // keyed on the `/internal` factory below until it went PUBLIC — the
    // scaffold's `server.mjs` needs it and may only import the published
    // surface — and a mock keyed where the code no longer imports from is not a
    // stale comment, it is a hard vitest error naming the missing export.
    // Inert here; the specs assert on the CALL.
    ensureSessionStateSchema: mockEnsureSessionStateSchema,
    ensureWorkflowJournalSchema: mockEnsureWorkflowJournalSchema,
  };
}

/**
 * The `@alexkroman1/aai-runtime/internal` half of the same mock.
 *
 * `publishStepEnv` moved to that subpath when the root barrel was curated, and
 * a factory for the barrel stopped covering it — silently, since the real one
 * only writes a `Symbol.for` slot and these specs serve no workflows, so every
 * spec kept passing while the mock covered nothing. Split rather than dropped:
 * what these specs assert is that `buildServer` publishes no real env.
 *
 * The logger and the delivery door joined it when the rest of the
 * `@internal` surface followed `publishStepEnv` off the root barrel — the
 * factory has to key each name where `_dev-server.ts` imports it from, or the
 * mock covers nothing for the same silent reason.
 *
 * It used to key a QUARTET: `configureWorkflowWorld`, `createWorkflowSurface`
 * and `startWorkflowWorldIfDeclared` went with the Workflow DevKit and are not
 * exports of that subpath any more. An extra key is not an error the way a
 * missing one is, so they sat here describing nothing.
 */
export function aaiRuntimeInternalModule(): Record<string, unknown> {
  return {
    publishStepEnv: vi.fn(),
    // The console-backed logger the dev server hands the runtime in human
    // mode (see createDevLogger); these specs only need it to exist.
    consoleLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    // The platform's delivery door, mounted on `createServer`'s `request` hook.
    // Declining is the case every spec in these files uses — they serve no
    // workflows; `dev-workflow.scenario.test.ts` covers the wired-up path
    // against real bundles.
    handleWorkflowRequest: vi.fn(() => false),
    // The two halves of the workflow-storage seam: the process-scoped journal
    // every rebuild's runtime is handed, and the env key the local data
    // directory is declared under.
    createMemoryJournal: mockCreateMemoryJournal,
    WORKFLOW_DATA_DIR_ENV: WORKFLOW_DATA_DIR_ENV_LITERAL,
  };
}

export function configModule(): Record<string, unknown> {
  return { ensureApiKey: mockEnsureApiKey };
}

export function serverCommonModule(): Record<string, unknown> {
  return { resolveServerEnv: mockResolveServerEnv };
}

export function uiModule(): Record<string, unknown> {
  const log = makeMockLog();
  return {
    log,
    // `notify` is the JSON-mode-surviving channel the long-running watch loop
    // reports through (see _ui.ts). Delegating to the same mock log keeps the
    // specs asserting on the level they care about rather than on the wrapper.
    notify: vi.fn((level: "error" | "warn" | "info" | "success", message: string) => {
      log[level](message);
    }),
    fmtUrl: vi.fn((url: string) => url),
    // The dev server asks whether output is silenced to pick the runtime's
    // logger (see createDevLogger). These specs run in human mode.
    outputSilenced: vi.fn(() => false),
  };
}

export function defaultHtmlModule(): Record<string, unknown> {
  return { fallbackHtmlPlugin: vi.fn().mockReturnValue({ name: "mock-plugin" }) };
}

export async function utilsModule(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<typeof import("./_utils.ts")>("./_utils.ts");
  return { ...actual, validateAgentExport: mockValidateAgentExport };
}
