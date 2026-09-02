// Copyright 2025 the AAI authors. MIT license.
// Watch-loop WIRING specs: chokidar event → debounce → the restart supervisor
// → a real rebuild, and the teardown that closes the watcher with the server.
//
// The restart state machine itself (queueing during boot, build-before-close
// ordering, listen retries, the teardown races) is specced directly and
// mock-free in `_dev-restart.test.ts`. Only assertions that need the real
// wiring belong here — everything else pays a full bundler build per restart
// for coverage the supervisor spec gets in microseconds.

import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  chokidarState,
  mockClose,
  mockCreateMemoryJournal,
  mockCreateRuntime,
  mockCreateServer,
  mockListen,
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

import { startDevServer } from "./_dev-server.ts";

// 30s, not the 5s default: sibling suites run multi-second runtime-inlining
// builds now, and CPU starvation under full-repo parallel runs was flaking
// these otherwise-fast tests. The inner vi.waitFor ceilings below are 15s
// for the same reason — each restart runs a REAL bundler build, so a 1-2s
// bound that always holds standalone flakes under a contended `turbo run
// test`. waitFor settles as soon as the condition holds, so the generous
// ceiling costs nothing on the happy path.
vi.setConfig({ testTimeout: 30_000 });

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  // File watching is opt-in since it defaults OFF (see devWatchEnabled) — these
  // suites exercise the watcher, so they turn it on. `unstubEnvs` in
  // vitest.shared.ts undoes this before each test; no manual cleanup.
  vi.stubEnv("AAI_DEV_WATCH", "1");
  // Clears the shared mocks' CALL HISTORY as well as re-priming them — see the
  // note on `primeDevServerMocks`. The mid-test `mockClear()`s below are a
  // different job: they cut a test's BOOT phase off from the restart it is
  // actually asserting on.
  primeDevServerMocks();
  mockValidateAgentExport.mockImplementation(() => undefined);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("startDevServer watch wiring", () => {
  test("a chokidar change event drives a full rebuild and re-listen", async () => {
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
        { timeout: 15_000 },
      );

      await cleanup();
    });
  });

  /**
   * STORAGE per PROCESS, CODE per BUILD.
   *
   * A rebuild replaces the workflow ENGINE — that is what makes a save reload a
   * workflow body — and it used to replace the store underneath it too, because
   * `createInProcessWorkflowEngine` defaults to a fresh `createMemoryJournal()`
   * when nobody hands it one. So under `aai dev` with no `DATABASE_URL`, a run
   * started before a save was gone after it and `GET /workflows/runs/:id`
   * answered 404 for a run the caller still held the id of.
   *
   * The wiring is one journal at process scope, passed to every build's
   * `createRuntime`. Asserted as IDENTITY across the calls rather than as a call
   * count, because "built once" is the property — a second `createMemoryJournal()`
   * is the bug whether or not the first one is still reachable.
   */
  test("every rebuild's runtime gets the SAME journal, so a run survives a save", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      fireChange(dir, "agent.ts");
      await vi.waitFor(() => expect(mockCreateRuntime.mock.calls.length).toBeGreaterThan(1), {
        timeout: 15_000,
      });

      const journals = mockCreateRuntime.mock.calls.map(([options]) => options.journal);
      expect(journals[0]).toBeDefined();
      for (const journal of journals) expect(journal).toBe(journals[0]);
      expect(mockCreateMemoryJournal).toHaveBeenCalledTimes(1);

      await cleanup();
    });
  });

  test("the watcher is installed before the initial listen", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      mockListen.mockClear();

      // Block startup at the initial listen and check the watcher is already
      // up: `ignoreInitial` means an edit saved during boot would otherwise
      // fire no event at all, and the dev server would serve stale code until
      // the next save. (That the event is then QUEUED rather than raced is the
      // supervisor's invariant, specced in _dev-restart.test.ts.)
      const initialListen = Promise.withResolvers<void>();
      mockListen.mockImplementationOnce(() => initialListen.promise);

      const startPromise = startDevServer({ cwd: dir, port: 3000 });
      // Reaching the initial listen runs a REAL bundler build, so the 1s
      // default holds standalone but flakes under a contended full-repo run.
      // Measured 2 failures in 5 five-project runs on the 1s bound versus 0
      // in 3 on the same commit's parent.
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalled(), { timeout: 15_000 });
      expect(chokidarState.allCallback).toBeDefined();

      initialListen.resolve();
      await (await startPromise)();
    });
  });

  test("cleanup closes the watcher alongside the server, once", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);

      const cleanup = await startDevServer({ cwd: dir, port: 3000 });
      mockClose.mockClear();

      await cleanup();
      await cleanup();

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(chokidarState.close).toHaveBeenCalledTimes(1);
    });
  });
});
