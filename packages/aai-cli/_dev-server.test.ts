// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentDef } from "@alexkroman1/aai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
} from "./_dev-server-test-utils.ts";
import { withTempDir } from "./_test-utils.ts";

// ─── Module mocks ───────────────────────────────────────────────────────────
// Factories (and the mock fns/state they wire up) live in the shared
// harness — see _dev-server-test-utils.ts. vi.mock calls must stay
// top-level in each test file for vitest's hoisting.

vi.mock("node:fs", async () => (await import("./_dev-server-test-utils.ts")).nodeFsModule());
vi.mock("chokidar", async () => (await import("./_dev-server-test-utils.ts")).chokidarModule());
vi.mock("get-port", async () => (await import("./_dev-server-test-utils.ts")).getPortModule());
vi.mock("@alexkroman1/aai/runtime", async () =>
  (await import("./_dev-server-test-utils.ts")).aaiRuntimeModule(),
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

import { loadAgentDef, startDevServer, watchDirectory } from "./_dev-server.ts";
import { log } from "./_ui.ts";

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

/** Write a minimal agent.ts in the given directory. */
async function writeAgentTs(dir: string, name = "test-agent"): Promise<void> {
  // The worker wrapper imports `@alexkroman1/aai/manifest`, so the fixture
  // project needs a resolvable node_modules — like any real project.
  await fs
    .symlink(path.resolve(import.meta.dirname, "node_modules"), path.join(dir, "node_modules"))
    .catch(() => undefined);
  await fs.writeFile(
    path.join(dir, "agent.ts"),
    `export default { name: "${name}", tools: {} };\n`,
  );
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(existsSync).mockReturnValue(false);
  chokidarState.allCallback = undefined;
  chokidarState.ignored = undefined;
  chokidarState.watchedDir = undefined;
  chokidarState.close = vi.fn().mockResolvedValue(undefined);
  mockChokidarWatch.mockClear();
  primeDevServerMocks();
  mockValidateAgentExport.mockImplementation(() => undefined);
});

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
      vi.doMock("vite", () => ({
        createServer: vi.fn().mockResolvedValue({
          close: vi.fn().mockResolvedValue(undefined),
          listen: vi.fn().mockResolvedValue(undefined),
        }),
      }));

      // Fresh import to pick up the vite mock
      const { startDevServer: freshStart } = await import("./_dev-server.ts");
      const cleanup = await freshStart({ cwd: dir, port: 3000 });

      // Second arg is the bind host: undefined here (AAI_DEV_HOST unset), so
      // the server applies its loopback default.
      expect(mockListen).toHaveBeenCalledWith(3001, undefined);

      await cleanup();
      vi.doUnmock("vite");
    });
  });

  test("falls back to ensureApiKey when ASSEMBLYAI_API_KEY is missing", async () => {
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

  test("does not call ensureApiKey when ASSEMBLYAI_API_KEY is present", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      mockResolveServerEnv.mockResolvedValue({ ASSEMBLYAI_API_KEY: "already-set" });
      mockEnsureApiKey.mockClear();

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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

describe("loadAgentDef", () => {
  const fakeDef = (name: string) => ({ name, tools: {} }) as AgentDef;

  test("hands the Vite-built worker to the evaluator", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir, "built-agent");
      const evaluated: string[] = [];
      const def = await loadAgentDef(dir, async (code) => {
        evaluated.push(code);
        return fakeDef("built-agent");
      });
      expect(def.name).toBe("built-agent");
      expect(evaluated[0]).toContain("built-agent");
    });
  });

  test("compile errors in the agent's code propagate", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {{{ nope\n");
      const evaluate = vi.fn();
      await expect(loadAgentDef(dir, evaluate)).rejects.toThrow();
      expect(evaluate).not.toHaveBeenCalled();
    });
  });
});
