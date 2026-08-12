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
import { vi } from "vitest";
import { makeMockLog } from "./_test-utils.ts";

// ─── Mock fns ────────────────────────────────────────────────────────────────

export const mockListen = vi.fn().mockResolvedValue(undefined);
export const mockClose = vi.fn().mockResolvedValue(undefined);
export const mockCreateRuntime = vi.fn().mockReturnValue({ runtime: "mock" });
export const mockCreateServer = vi.fn();
// The runtime barrel is mocked to keep it out of these specs, so this stands
// in for the real registry-derived lookup. The provider-less agent these
// tests write runs the default AssemblyAI pipeline, which needs an AssemblyAI
// key; the real function has its own specs in the aai package
// (providers/resolve.test.ts).
const mockRequiredProviderEnvVars = vi.fn().mockReturnValue(["ASSEMBLYAI_API_KEY"]);
export const mockEnsureApiKey = vi.fn().mockResolvedValue("test-api-key");
export const mockResolveServerEnv = vi.fn().mockResolvedValue({ ASSEMBLYAI_API_KEY: "test-key" });
export const mockValidateAgentExport = vi.fn();

// Wire mockCreateServer to return the mock server object.
mockCreateServer.mockReturnValue({ listen: mockListen, close: mockClose });

/**
 * Re-prime the default implementations. `restoreMocks: true` wipes them
 * between tests, so call this from `beforeEach` (both files already do).
 */
export function primeDevServerMocks(): void {
  mockListen.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockCreateRuntime.mockReturnValue({ runtime: "mock" });
  mockCreateServer.mockReturnValue({ listen: mockListen, close: mockClose });
  mockRequiredProviderEnvVars.mockReturnValue(["ASSEMBLYAI_API_KEY"]);
  mockEnsureApiKey.mockResolvedValue("test-api-key");
  mockResolveServerEnv.mockResolvedValue({ ASSEMBLYAI_API_KEY: "test-key" });
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
    // The console-backed logger the dev server hands the runtime in human
    // mode (see createDevLogger); these specs only need it to exist.
    consoleLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    // The workflow trio. Inert rather than absent: an agent with no
    // `workflows/` directory is the case every spec in these files uses, and
    // the real implementations would resolve a DevKit world just to answer
    // "there is nothing to serve". `dev-workflow.integration.test.ts` covers
    // the wired-up path against real bundles.
    configureWorkflowWorld: vi.fn(() => "local"),
    createWorkflowSurface: vi.fn(async () => undefined),
    handleWorkflowRequest: vi.fn(() => false),
    startWorkflowWorldIfDeclared: vi.fn(async () => undefined),
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
