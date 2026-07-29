// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { withTempDir } from "./_test-utils.ts";

// ─── Hoisted mock fns (survive vi.mock hoisting) ───────────────────────────

const {
  mockListen,
  mockClose,
  mockCreateRuntime,
  mockRequiredProviderEnvVars,
  mockCreateServer,
  mockEnsureApiKey,
  mockResolveServerEnv,
  mockValidateAgentExport,
} = vi.hoisted(() => ({
  mockListen: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockCreateRuntime: vi.fn().mockReturnValue({ runtime: "mock" }),
  mockCreateServer: vi.fn(),
  // The runtime barrel is mocked to keep it out of these specs, so this stands
  // in for the real registry-derived lookup. The default-S2S agent these tests
  // write needs an AssemblyAI key; the real function has its own specs in the
  // aai package (providers/resolve.test.ts).
  mockRequiredProviderEnvVars: vi.fn().mockReturnValue(["ASSEMBLYAI_API_KEY"]),
  mockEnsureApiKey: vi.fn().mockResolvedValue("test-api-key"),
  mockResolveServerEnv: vi.fn().mockResolvedValue({ ASSEMBLYAI_API_KEY: "test-key" }),
  mockValidateAgentExport: vi.fn(),
}));

// Wire mockCreateServer to return the mock server object
mockCreateServer.mockReturnValue({ listen: mockListen, close: mockClose });

// Fake chokidar: captures the watched dir, the `ignored` matcher, and the
// "all" event callback so tests can fire synthetic change events.
const { chokidarState, mockChokidarWatch } = vi.hoisted(() => {
  const chokidarState = {
    allCallback: undefined as ((event: string, filePath: string) => void) | undefined,
    errorCallback: undefined as ((err: unknown) => void) | undefined,
    ignored: undefined as ((filePath: string) => boolean) | undefined,
    close: vi.fn().mockResolvedValue(undefined),
    watchedDir: undefined as string | undefined,
  };
  const mockChokidarWatch = vi.fn(
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
  return { chokidarState, mockChokidarWatch };
});

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  };
});

vi.mock("chokidar", () => ({
  watch: mockChokidarWatch,
}));

// Deterministic port selection: always return the first candidate port.
vi.mock("get-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("get-port")>();
  return {
    ...actual,
    default: vi.fn(async (opts?: { port?: Iterable<number> }) => {
      const first = opts?.port?.[Symbol.iterator]().next().value;
      return first ?? 0;
    }),
  };
});

vi.mock("@alexkroman1/aai/runtime", () => ({
  createRuntime: mockCreateRuntime,
  createServer: mockCreateServer,
  requiredProviderEnvVars: mockRequiredProviderEnvVars,
  // The dev server applies the self-hosted credential fallback when building
  // `env`; identity here keeps these tests focused on wiring. The helper's own
  // behavior is covered in aai/host/providers/host-env.test.ts.
  withHostCredentialFallback: (env: Record<string, string>) => env,
}));

vi.mock("./_config.ts", () => ({
  ensureApiKey: mockEnsureApiKey,
}));

vi.mock("./_server-common.ts", () => ({
  resolveServerEnv: mockResolveServerEnv,
}));

vi.mock("./_ui.ts", async () => ({
  log: (await import("./_test-utils.ts")).makeMockLog(),
  fmtUrl: vi.fn((url: string) => url),
}));

vi.mock("./_default-html.ts", () => ({
  fallbackHtmlPlugin: vi.fn().mockReturnValue({ name: "mock-plugin" }),
}));

vi.mock("./_utils.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_utils.ts")>()),
  validateAgentExport: mockValidateAgentExport,
}));

// ─── Imports under test (after mocks) ───────────────────────────────────────

import { startDevServer } from "./_dev-server.ts";
import { log } from "./_ui.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Write a minimal agent.ts in the given directory. */
async function writeAgentTs(dir: string, name = "test-agent"): Promise<void> {
  await fs.writeFile(
    path.join(dir, "agent.ts"),
    `export default { name: "${name}", tools: {} };\n`,
  );
}

/** Fire a synthetic chokidar change event for a path inside `dir`. */
function fireChange(dir: string, relPath: string): void {
  chokidarState.allCallback?.("change", path.join(dir, relPath));
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(existsSync).mockReturnValue(false);
  chokidarState.allCallback = undefined;
  chokidarState.ignored = undefined;
  chokidarState.watchedDir = undefined;
  chokidarState.close = vi.fn().mockResolvedValue(undefined);
  mockChokidarWatch.mockClear();
  mockCreateRuntime.mockReturnValue({ runtime: "mock" });
  mockCreateServer.mockReturnValue({ listen: mockListen, close: mockClose });
  mockListen.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockResolveServerEnv.mockResolvedValue({ ASSEMBLYAI_API_KEY: "test-key" });
  mockEnsureApiKey.mockResolvedValue("test-api-key");
  mockValidateAgentExport.mockImplementation(() => undefined);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("startDevServer restart behavior", () => {
  test("watcher triggers restart on agent file change", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      mockClose.mockClear();
      mockCreateRuntime.mockClear();
      mockCreateServer.mockClear();
      mockListen.mockClear();

      // Trigger with a regular file change
      fireChange(dir, "agent.ts");

      // Wait for the 300ms debounce + full async restart sequence
      await vi.waitFor(
        () => {
          expect(mockClose).toHaveBeenCalled();
          expect(mockCreateRuntime).toHaveBeenCalled();
          expect(mockCreateServer).toHaveBeenCalled();
          expect(mockListen).toHaveBeenCalled();
        },
        { timeout: 1000 },
      );

      await cleanup();
    });
  });

  test("builds the new server before closing the old one on restart", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      mockClose.mockClear();
      mockCreateServer.mockClear();
      mockListen.mockClear();

      fireChange(dir, "agent.ts");

      await vi.waitFor(
        () => {
          expect(mockListen).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      // Build (createServer) completes BEFORE the old server closes, so the
      // down-window is only the close+listen swap — not the whole rebuild.
      const createOrder = mockCreateServer.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
      const closeOrder = mockClose.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
      const listenOrder = mockListen.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
      expect(createOrder).toBeLessThan(closeOrder);
      expect(closeOrder).toBeLessThan(listenOrder);

      await cleanup();
    });
  });

  test("edit saved during startup triggers one restart after startup completes", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      mockCreateServer.mockClear();
      mockListen.mockClear();

      // Block startup at the initial listen so the change event lands mid-boot.
      let releaseListen!: () => void;
      mockListen.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseListen = resolve;
          }),
      );

      const startPromise = startDevServer({ cwd: dir, port: 3000 });
      // The watcher must exist before the initial build/listen finishes —
      // otherwise a save during boot never fires an event at all.
      await vi.waitFor(() => expect(chokidarState.allCallback).toBeDefined());
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalled());

      fireChange(dir, "agent.ts");
      // Let the debounce elapse while startup is still blocked: the event must
      // be queued, not start a restart racing the initial build.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(mockCreateServer).toHaveBeenCalledTimes(1);

      releaseListen();
      const cleanup = await startPromise;

      await vi.waitFor(() => expect(mockCreateServer).toHaveBeenCalledTimes(2), {
        timeout: 5000,
      });

      await cleanup();
    });
  });

  test("restart retries listen when the port is momentarily taken", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      mockListen.mockClear();
      vi.mocked(log.success).mockClear();
      // Two rejected attempts, then the default (resolving) implementation
      // from beforeEach serves the third — nothing queued leaks past the test.
      mockListen
        .mockRejectedValueOnce(new Error("EADDRINUSE"))
        .mockRejectedValueOnce(new Error("EADDRINUSE"));

      fireChange(dir, "agent.ts");

      await vi.waitFor(() => expect(log.success).toHaveBeenCalledWith("Restarted"), {
        timeout: 5000,
      });
      expect(mockListen).toHaveBeenCalledTimes(3);

      await cleanup();
    });
  });

  test("restart logs a save-to-retry hint when listen fails after all retries", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      mockListen.mockClear();
      vi.mocked(log.error).mockClear();
      // Exactly three rejected attempts; later calls fall back to the default
      // resolving implementation so nothing queued leaks past the test.
      mockListen
        .mockRejectedValueOnce(new Error("EADDRINUSE"))
        .mockRejectedValueOnce(new Error("EADDRINUSE"))
        .mockRejectedValueOnce(new Error("EADDRINUSE"));

      fireChange(dir, "agent.ts");

      await vi.waitFor(
        () => expect(log.error).toHaveBeenCalledWith(expect.stringContaining("save a file")),
        { timeout: 5000 },
      );
      expect(mockListen).toHaveBeenCalledTimes(3);

      await cleanup();
    });
  });

  // SIGINT then SIGTERM invokes cleanup twice — the teardown must run once.
  test("cleanup is idempotent: second call joins the in-flight teardown", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      mockClose.mockClear();

      const first = cleanup();
      const second = cleanup();
      expect(second).toBe(first);
      await first;
      await cleanup();

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(chokidarState.close).toHaveBeenCalledTimes(1);
    });
  });

  test("restart logs error on failure instead of crashing", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      // After initial load, make validation throw on next reload
      mockValidateAgentExport.mockImplementation(() => {
        throw new Error("agent broke");
      });

      mockClose.mockClear();

      // Actually change the file: an unchanged bundle is served from the
      // eval memo (createWorkerEvaluator) and never re-validated.
      await writeAgentTs(dir, "test-agent-v2");
      fireChange(dir, "agent.ts");

      await vi.waitFor(
        () => {
          expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Restart failed"));
        },
        { timeout: 2000 },
      );

      // A failed build must leave the previous server running: no close.
      expect(mockClose).not.toHaveBeenCalled();

      await cleanup();
    });
  });
});
