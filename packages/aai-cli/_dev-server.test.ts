// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentDef } from "@alexkroman1/aai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  chokidarState,
  mockChokidarWatch,
  mockClose,
  mockCreateRuntime,
  mockCreateServer,
  mockEnsureApiKey,
  mockListen,
  mockResolveServerEnv,
  mockValidateAgentExport,
  primeDevServerMocks,
  writeAgentTs,
} from "./_dev-server-test-utils.ts";
import { withTempDir } from "./_test-utils.ts";

// ─── Module mocks ───────────────────────────────────────────────────────────
// Factories (and the mock fns/state they wire up) live in the shared
// harness — see _dev-server-test-utils.ts. vi.mock calls must stay
// top-level in each test file for vitest's hoisting.

vi.mock("node:fs", async () => (await import("./_dev-server-test-utils.ts")).nodeFsModule());
vi.mock("chokidar", async () => (await import("./_dev-server-test-utils.ts")).chokidarModule());
vi.mock("get-port", async () => (await import("./_dev-server-test-utils.ts")).getPortModule());
vi.mock("@alexkroman1/aai-runtime", async () =>
  (await import("./_dev-server-test-utils.ts")).aaiRuntimeModule(),
);
vi.mock("@alexkroman1/aai-runtime/internal", async () =>
  (await import("./_dev-server-test-utils.ts")).aaiRuntimeInternalModule(),
);
vi.mock("./_config.ts", async () => (await import("./_dev-server-test-utils.ts")).configModule());
vi.mock("./_server-common.ts", async () =>
  (await import("./_dev-server-test-utils.ts")).serverCommonModule(),
);
vi.mock("./_ui.ts", async () => (await import("./_dev-server-test-utils.ts")).uiModule());
vi.mock("./_default-html.ts", async () =>
  (await import("./_dev-server-test-utils.ts")).defaultHtmlModule(),
);
vi.mock("./_utils.ts", async () => (await import("./_dev-server-test-utils.ts")).utilsModule());

// ─── Imports under test (after mocks) ───────────────────────────────────────

import { createDevLogger } from "./_dev-env.ts";
import { loadWorker, startDevServer, watchDirectory } from "./_dev-server.ts";
import { log } from "./_ui.ts";

// 30s, not the 5s default: sibling suites run multi-second runtime-inlining
// builds now, and CPU starvation under full-repo parallel runs was flaking
// these otherwise-fast tests.
vi.setConfig({ testTimeout: 30_000 });

describe("watchDirectory", () => {
  test("logs watcher errors, with an inotify hint for ENOSPC", () => {
    watchDirectory("/tmp/watched", () => undefined);
    const enospc = Object.assign(new Error("watch limit"), { code: "ENOSPC" });
    chokidarState.errorCallback?.(enospc);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("max_user_watches"));

    chokidarState.errorCallback?.(new Error("disk gone"));
    expect(log.error).toHaveBeenLastCalledWith(expect.stringContaining("disk gone"));
    expect(log.error).toHaveBeenLastCalledWith(expect.not.stringContaining("max_user_watches"));
  });

  test("a throwing onChange is logged, not an unhandled rejection", async () => {
    watchDirectory("/tmp/watched", () => {
      throw new Error("restart exploded");
    });
    chokidarState.allCallback?.("change", "/tmp/watched/agent.ts");
    // The debounce window is 300ms; the throw surfaces via the catch handler.
    await vi.waitFor(() =>
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("restart exploded")),
    );
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Install a `vite` module mock for the duration of `fn`, then unmock it.
 *
 * The unmock is in a `finally` and that is the whole point: written inline, a
 * failed assertion above `vi.doUnmock("vite")` leaves the mock installed for
 * every LATER test that reaches the client-build branch, so one red test turns
 * into a cascade that names the wrong cause.
 *
 * It stays in THIS file rather than in `_dev-server-test-utils.ts`, even
 * though both callers are here: that module is the factory source for every
 * `vi.mock(...)` above, and adding a `vi.doMock` to it makes the mock registry
 * reach back into a module it is mocking from — which HANGS the run rather
 * than failing it (the same trap `aaiRuntimeModule`'s comment records).
 */
async function withViteMock(
  factory: () => Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  vi.doMock("vite", factory);
  try {
    await fn();
  } finally {
    vi.doUnmock("vite");
  }
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(existsSync).mockReturnValue(false);
  chokidarState.allCallback = undefined;
  chokidarState.ignored = undefined;
  chokidarState.watchedDir = undefined;
  chokidarState.close = vi.fn().mockResolvedValue(undefined);
  // File watching is opt-in since it defaults OFF (see devWatchEnabled) — these
  // suites exercise the watcher, so they turn it on. `unstubEnvs` in
  // vitest.shared.ts undoes this before each test; no manual cleanup.
  vi.stubEnv("AAI_DEV_WATCH", "1");
  // Clears the shared mocks' CALL HISTORY as well as re-priming them — see the
  // note on `primeDevServerMocks`. Without it every `toHaveBeenCalledWith` in
  // this file could be satisfied by an earlier test's call.
  primeDevServerMocks();
  mockValidateAgentExport.mockImplementation(() => undefined);
});

// Several tests here stub env vars the dev server reads (ASSEMBLYAI_API_KEY,
// AAI_DEV_HOST, AAI_ALLOW_HOST); `unstubEnvs` in vitest.shared.ts undoes each
// one before the next test, so no test owns teardown for them. (This comment
// used to warn that `restoreMocks` does not — true, and not the option that
// governs env stubs.)

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("startDevServer", () => {
  test("loads agent, resolves env, creates runtime and server", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      expect(mockResolveServerEnv).toHaveBeenCalledWith(dir);
      expect(mockCreateRuntime).toHaveBeenCalledWith({
        agent: { name: "test-agent", tools: {} },
        env: { ASSEMBLYAI_API_KEY: "test-key" },
        // Credentials resolve from providerEnv; ctx.env stays as `env` so dev
        // matches production in what agent code can read.
        providerEnv: { ASSEMBLYAI_API_KEY: "test-key" },
        // The runtime logs through a logger this command chooses, so its
        // diagnostics can be kept off stdout in JSON mode (createDevLogger).
        logger: expect.objectContaining({ info: expect.any(Function) }),
        // What `ctx.workflows.publicWebhookUrl` mints from. The BACKEND port —
        // which with no `client.tsx` is the port passed in — because the DevKit's
        // `/.well-known/workflow/v1/*` routes are deliberately absent from Vite's
        // proxy table, so a URL naming the Vite port would 404 on delivery.
        publicUrl: "http://localhost:3000",
      });
      expect(mockCreateServer).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: { runtime: "mock" },
          name: "test-agent",
        }),
      );
      // Second arg is the bind host: undefined here (AAI_DEV_HOST unset), so
      // the server applies its loopback default.
      expect(mockListen).toHaveBeenCalledWith(3000, undefined);

      await cleanup();
    });
  });

  test("returns a cleanup function that closes watchers and server", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      expect(typeof cleanup).toBe("function");

      await cleanup();

      expect(chokidarState.close).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  test("uses port directly when no client.tsx exists", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      vi.mocked(existsSync).mockReturnValue(false);

      const cleanup = await startDevServer({ cwd: dir, port: 4000 });
      // Second arg is the bind host: undefined here (AAI_DEV_HOST unset), so
      // the server applies its loopback default.
      expect(mockListen).toHaveBeenCalledWith(4000, undefined);
      await cleanup();
    });
  });

  test("uses port+1 for backend when client.tsx exists", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      vi.mocked(existsSync).mockImplementation((p: import("node:fs").PathLike) =>
        String(p).endsWith("client.tsx"),
      );

      // Mock vite (dynamically imported when client.tsx exists)
      await withViteMock(
        () => ({
          createServer: vi.fn().mockResolvedValue({
            close: vi.fn().mockResolvedValue(undefined),
            listen: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        async () => {
          // Fresh import to pick up the vite mock
          const { startDevServer: freshStart } = await import("./_dev-server.ts");
          const cleanup = await freshStart({ cwd: dir, port: 3000 });

          // Second arg is the bind host: undefined here (AAI_DEV_HOST unset), so
          // the server applies its loopback default.
          expect(mockListen).toHaveBeenCalledWith(3001, undefined);

          await cleanup();
        },
      );
    });
  });

  // The backend binds the port before Vite boots, and startDevServer throws
  // on a Vite failure — so without an explicit close it stays listening with
  // nothing holding a handle to it. `aai dev` would then report a startup
  // failure and leave the port occupied against the retry.
  test("a Vite failure closes the backend that already bound", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      vi.mocked(existsSync).mockImplementation((p: import("node:fs").PathLike) =>
        String(p).endsWith("client.tsx"),
      );
      await withViteMock(
        () => ({
          createServer: vi.fn().mockResolvedValue({
            close: vi.fn().mockResolvedValue(undefined),
            listen: vi.fn().mockRejectedValue(new Error("vite port taken")),
          }),
        }),
        async () => {
          const { startDevServer: freshStart } = await import("./_dev-server.ts");

          await expect(freshStart({ cwd: dir, port: 3000 })).rejects.toThrow("vite port taken");

          expect(mockListen).toHaveBeenCalled();
          expect(mockClose).toHaveBeenCalledTimes(1);
          expect(chokidarState.close).toHaveBeenCalledTimes(1);
        },
      );
    });
  });

  test("falls back to the logged-in key when .env declares none", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      mockResolveServerEnv.mockResolvedValue({ OTHER_VAR: "value" });
      mockEnsureApiKey.mockResolvedValue("fallback-key");

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      expect(mockEnsureApiKey).toHaveBeenCalled();
      expect(mockCreateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            ASSEMBLYAI_API_KEY: "fallback-key",
          }),
        }),
      );

      await cleanup();
    });
  });

  /**
   * A shell-exported key no longer authenticates the CLI (`ensureApiKey`
   * reads the login key alone), but it is still a provider credential the dev
   * server honors through `withHostCredentialFallback`. So `aai dev` must not
   * demand a login for a developer who exports it the usual way — and the key
   * must stay out of `ctx.env`, where it would break dev/prod parity.
   */
  test("does not require a login when the key is exported in the shell", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      vi.stubEnv("ASSEMBLYAI_API_KEY", "shell-key");
      mockResolveServerEnv.mockResolvedValue({ OTHER_VAR: "value" });

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      expect(mockEnsureApiKey).not.toHaveBeenCalled();
      expect(mockCreateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.not.objectContaining({ ASSEMBLYAI_API_KEY: expect.anything() }),
        }),
      );

      await cleanup();
    });
  });

  test("does not call ensureApiKey when .env declares ASSEMBLYAI_API_KEY", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      mockResolveServerEnv.mockResolvedValue({ ASSEMBLYAI_API_KEY: "already-set" });

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      expect(mockEnsureApiKey).not.toHaveBeenCalled();

      await cleanup();
    });
  });

  test("sets up file watcher on the agent directory", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      expect(mockChokidarWatch).toHaveBeenCalledWith(
        dir,
        expect.objectContaining({
          ignoreInitial: true,
          persistent: false,
          ignored: expect.any(Function),
        }),
      );

      await cleanup();
    });
  });

  test("does NOT watch by default — AAI_DEV_WATCH is opt-in", async () => {
    // A restart replaces the server and ends in-flight voice sessions, which is
    // right while editing an agent and wrong while a benchmark drives the host:
    // a formatter save or a `.env` touch restarts underneath the run and the
    // harness reports it as a provider failure. Cleanup must also survive the
    // absent watcher — `watcher?.close()` — or every shutdown throws
    // "Cannot read properties of undefined (reading 'close')".
    vi.stubEnv("AAI_DEV_WATCH", "");
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      expect(mockChokidarWatch).not.toHaveBeenCalled();

      await expect(cleanup()).resolves.toBeUndefined();
    });
  });

  test("validates the agent export via validateAgentExport", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      expect(mockValidateAgentExport).toHaveBeenCalledWith({ name: "test-agent", tools: {} });

      await cleanup();
    });
  });

  test("throws when agent.ts has no default export", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), "export const notDefault = 42;\n");

      // The worker wrapper re-exports the default, so a missing default
      // export fails the build itself — with an error naming agent.ts.
      await expect(startDevServer({ cwd: dir, port: 3000 })).rejects.toThrow(
        /"default" is not exported/,
      );
    });
  });

  test("throws when agent.ts file does not exist", async () => {
    await withTempDir(async (dir) => {
      // No agent.ts — dynamic import will fail
      await expect(startDevServer({ cwd: dir, port: 3000 })).rejects.toThrow();
    });
  });

  test("provides clientDir when no client.tsx exists", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      vi.mocked(existsSync).mockReturnValue(false);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      expect(mockCreateServer).toHaveBeenCalledWith(
        expect.objectContaining({
          clientDir: expect.any(String),
        }),
      );

      await cleanup();
    });
  });
});

describe("file watcher filtering", () => {
  test("chokidar ignored matcher filters .aai and node_modules paths", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      const ignored = chokidarState.ignored;
      expect(ignored).toBeDefined();
      expect(ignored?.(path.join(dir, ".aai", "cache"))).toBe(true);
      expect(ignored?.(path.join(dir, "node_modules", "pkg", "index.js"))).toBe(true);
      expect(ignored?.(path.join(dir, "agent.ts"))).toBe(false);
      expect(ignored?.(path.join(dir, "tools", "search.ts"))).toBe(false);

      await cleanup();
    });
  });

  test("ignored matcher filters dot-directories (.git etc.) but keeps .env watched", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      const ignored = chokidarState.ignored;
      expect(ignored).toBeDefined();
      // .git activity (commits, index writes) must never restart the server.
      expect(ignored?.(path.join(dir, ".git"))).toBe(true);
      expect(ignored?.(path.join(dir, ".git", "index.lock"))).toBe(true);
      expect(ignored?.(path.join(dir, ".git", "refs", "heads", "main"))).toBe(true);
      // Other dot-directories (editor caches, VCS metadata) are ignored too.
      expect(ignored?.(path.join(dir, ".vscode", "settings.json"))).toBe(true);
      expect(ignored?.(path.join(dir, ".cache", "x", "y.ts"))).toBe(true);
      expect(ignored?.(path.join(dir, "sub", ".hidden", "file.ts"))).toBe(true);
      // .env files stay watched — env edits should restart with new values.
      expect(ignored?.(path.join(dir, ".env"))).toBe(false);
      expect(ignored?.(path.join(dir, ".env.local"))).toBe(false);
      // The watch root itself is never ignored.
      expect(ignored?.(dir)).toBe(false);

      await cleanup();
    });
  });
});

describe("dev server bind host", () => {
  test("binds loopback by default (no host argument)", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      expect(mockListen).toHaveBeenCalledWith(3000, undefined);
      await cleanup();
    });
  });

  test("AAI_DEV_HOST exposes the server on the requested interface", async () => {
    vi.stubEnv("AAI_DEV_HOST", "0.0.0.0");
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      expect(mockListen).toHaveBeenCalledWith(3000, "0.0.0.0");
      await cleanup();
    });
  });

  // Node treats listen(port, "") as 0.0.0.0, so an empty value must read as
  // "unset" rather than silently undoing the loopback default.
  test.each(["", "   "])("treats AAI_DEV_HOST=%o as unset", async (value: string) => {
    vi.stubEnv("AAI_DEV_HOST", value);
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      expect(mockListen).toHaveBeenCalledWith(3000, undefined);
      await cleanup();
    });
  });
});

describe("dev server host mode gate", () => {
  // resolveServerEnv only surfaces keys declared in `.env`, so without an
  // explicit pass-through the shell-exported gate would never reach
  // isHostAllowed and host mode would be unreachable in `aai dev`.
  test("passes AAI_ALLOW_HOST through from the shell", async () => {
    vi.stubEnv("AAI_ALLOW_HOST", "1");
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      expect(mockCreateServer).toHaveBeenCalledWith(
        expect.objectContaining({ env: expect.objectContaining({ AAI_ALLOW_HOST: "1" }) }),
      );
      await cleanup();
    });
  });

  test("omits the gate entirely when unset", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      const opts = mockCreateServer.mock.calls.at(-1)?.[0] as { env: Record<string, string> };
      expect(opts.env).not.toHaveProperty("AAI_ALLOW_HOST");
      await cleanup();
    });
  });
});

describe("loadWorker", () => {
  const fakeWorker = (name: string) => ({
    agent: { name, tools: {} } as AgentDef,
    workflowCode: undefined,
    stepCode: undefined,
  });

  test("hands the Vite-built worker to the evaluator", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir, "built-agent");
      const evaluated: string[] = [];
      const worker = await loadWorker(dir, async (code) => {
        evaluated.push(code);
        return fakeWorker("built-agent");
      });
      expect(worker.agent.name).toBe("built-agent");
      expect(evaluated[0]).toContain("built-agent");
    });
  });

  test("compile errors in the agent's code propagate", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {{{ nope\n");
      const evaluate = vi.fn();
      await expect(loadWorker(dir, evaluate)).rejects.toThrow();
      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  test("a project with no workflows/ directory carries no workflow code", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir, "no-workflows");
      const worker = await loadWorker(dir, async (code) => {
        // The wrapper entry only emits the two exports when the build produced
        // them, so their absence from the SOURCE is what the guest-side
        // "declares no workflows" check reads.
        expect(code).not.toContain("__aaiWorkflowCode");
        return fakeWorker("no-workflows");
      });
      expect(worker.workflowCode).toBeUndefined();
    });
  });
});

describe("createDevLogger", () => {
  // `aai dev` writes its one JSON result line and then keeps running, so the
  // runtime's own diagnostics have to go somewhere that isn't stdout. They
  // were going to stdout: the SDK's default logger is console-backed, and the
  // multi-line "Session mode resolved" dump landed above the result line — in
  // the NORMAL case, since JSON mode is auto-detected on a pipe.
  test("routes the runtime's diagnostics to stderr once output is silenced", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logger = createDevLogger(true);

    logger.info("Session mode resolved", { mode: "pipeline" });
    logger.warn("something drifted");
    logger.error("something broke");

    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(3);
    // The structured context survives rather than being dropped.
    expect(String(err.mock.calls[0]?.[0])).toContain('{"mode":"pipeline"}');
  });

  test("debug stays off in silenced mode", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createDevLogger(true).debug("hot path", { chunk: 1 });
    expect(err).not.toHaveBeenCalled();
  });

  test("human mode hands back the SDK's own console logger untouched", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createDevLogger(false).info("Session mode resolved");
    // A TTY has nothing to parse, so human mode must not be rerouted.
    expect(err).not.toHaveBeenCalled();
  });
});
