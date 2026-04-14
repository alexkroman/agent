// Copyright 2025 the AAI authors. MIT license.

import { existsSync, type FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { withTempDir } from "./_test-utils.ts";

// ─── Hoisted mock fns (survive vi.mock hoisting) ───────────────────────────

const {
  mockListen,
  mockClose,
  mockCreateRuntime,
  mockCreateServer,
  mockEnsureApiKey,
  mockResolveServerEnv,
  mockValidateAgentExport,
} = vi.hoisted(() => ({
  mockListen: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockCreateRuntime: vi.fn().mockReturnValue({ runtime: "mock" }),
  mockCreateServer: vi.fn(),
  mockEnsureApiKey: vi.fn().mockResolvedValue("test-api-key"),
  mockResolveServerEnv: vi.fn().mockResolvedValue({ ASSEMBLYAI_API_KEY: "test-key" }),
  mockValidateAgentExport: vi.fn(),
}));

// Wire mockCreateServer to return the mock server object
mockCreateServer.mockReturnValue({ listen: mockListen, close: mockClose });

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    watch: vi.fn().mockReturnValue({ close: vi.fn() }),
  };
});

vi.mock("@alexkroman1/aai/runtime", () => ({
  createRuntime: mockCreateRuntime,
  createServer: mockCreateServer,
}));

vi.mock("./_config.ts", () => ({
  ensureApiKey: mockEnsureApiKey,
}));

vi.mock("./_server-common.ts", () => ({
  resolveServerEnv: mockResolveServerEnv,
}));

vi.mock("./_ui.ts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  fmtUrl: vi.fn((url: string) => url),
}));

vi.mock("./_default-html.ts", () => ({
  fallbackHtmlPlugin: vi.fn().mockReturnValue({ name: "mock-plugin" }),
}));

vi.mock("./_utils.ts", () => ({
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

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(watch).mockReturnValue({ close: vi.fn() } as unknown as FSWatcher);
  mockCreateRuntime.mockReturnValue({ runtime: "mock" });
  mockCreateServer.mockReturnValue({ listen: mockListen, close: mockClose });
  mockListen.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockResolveServerEnv.mockResolvedValue({ ASSEMBLYAI_API_KEY: "test-key" });
  mockEnsureApiKey.mockResolvedValue("test-api-key");
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
      });
      expect(mockCreateServer).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: { runtime: "mock" },
          name: "test-agent",
        }),
      );
      expect(mockListen).toHaveBeenCalledWith(3000);

      await cleanup();
    });
  });

  test("returns a cleanup function that closes watchers and server", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const mockWatcherClose = vi.fn();
      vi.mocked(watch).mockReturnValue({
        close: mockWatcherClose,
      } as unknown as FSWatcher);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      expect(typeof cleanup).toBe("function");

      await cleanup();

      expect(mockWatcherClose).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  test("uses port directly when no client.tsx exists", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      vi.mocked(existsSync).mockReturnValue(false);

      const cleanup = await startDevServer({ cwd: dir, port: 4000 });
      expect(mockListen).toHaveBeenCalledWith(4000);
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

      expect(mockListen).toHaveBeenCalledWith(3001);

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

      expect(watch).toHaveBeenCalledWith(dir, { persistent: false }, expect.any(Function));

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

  test("throws when agent.ts has invalid default export", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export const notDefault = 42;\n");

      mockValidateAgentExport.mockImplementation((mod: unknown) => {
        if (!mod || typeof mod !== "object" || !("name" in mod)) {
          throw new Error("agent.ts must export default agent({ name: ... })");
        }
      });

      await expect(startDevServer({ cwd: dir, port: 3000 })).rejects.toThrow(
        "agent.ts must export default agent({ name: ... })",
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
  test("watcher ignores .aai directory changes", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op default for watcher callback
      let watchCallback: (event: string, filename: string | null) => void = () => {};
      vi.mocked(watch).mockImplementation((_dir, _opts, cb) => {
        watchCallback = cb as typeof watchCallback;
        return { close: vi.fn() } as unknown as FSWatcher;
      });

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      mockClose.mockClear();
      mockCreateRuntime.mockClear();

      // Trigger with .aai path — should be ignored
      watchCallback("change", ".aai/cache");

      // Wait longer than the 300ms debounce
      await new Promise((r) => setTimeout(r, 500));

      expect(mockClose).not.toHaveBeenCalled();

      await cleanup();
    });
  });

  test("watcher ignores node_modules changes", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op default for watcher callback
      let watchCallback: (event: string, filename: string | null) => void = () => {};
      vi.mocked(watch).mockImplementation((_dir, _opts, cb) => {
        watchCallback = cb as typeof watchCallback;
        return { close: vi.fn() } as unknown as FSWatcher;
      });

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      mockClose.mockClear();

      watchCallback("change", "node_modules/pkg/index.js");

      await new Promise((r) => setTimeout(r, 500));

      expect(mockClose).not.toHaveBeenCalled();

      await cleanup();
    });
  });

  test("watcher triggers restart on agent file change", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op default for watcher callback
      let watchCallback: (event: string, filename: string | null) => void = () => {};
      vi.mocked(watch).mockImplementation((_dir, _opts, cb) => {
        watchCallback = cb as typeof watchCallback;
        return { close: vi.fn() } as unknown as FSWatcher;
      });

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      mockClose.mockClear();
      mockCreateRuntime.mockClear();
      mockCreateServer.mockClear();
      mockListen.mockClear();

      // Trigger with a regular file change
      watchCallback("change", "agent.ts");

      // Wait for the 300ms debounce + buffer
      await vi.waitFor(
        () => {
          expect(mockClose).toHaveBeenCalled();
        },
        { timeout: 1000 },
      );

      expect(mockCreateRuntime).toHaveBeenCalled();
      expect(mockCreateServer).toHaveBeenCalled();
      expect(mockListen).toHaveBeenCalled();

      await cleanup();
    });
  });

  test("restart logs error on failure instead of crashing", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op default for watcher callback
      let watchCallback: (event: string, filename: string | null) => void = () => {};
      vi.mocked(watch).mockImplementation((_dir, _opts, cb) => {
        watchCallback = cb as typeof watchCallback;
        return { close: vi.fn() } as unknown as FSWatcher;
      });

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });

      // After initial load, make validation throw on next reload
      mockValidateAgentExport.mockImplementation(() => {
        throw new Error("agent broke");
      });

      mockClose.mockClear();

      watchCallback("change", "agent.ts");

      await vi.waitFor(
        () => {
          expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Restart failed"));
        },
        { timeout: 2000 },
      );

      await cleanup();
    });
  });
});
