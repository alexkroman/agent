// Copyright 2025 the AAI authors. MIT license.
// Watch-loop WIRING specs: watcher event → debounce → the restart supervisor
// → a real rebuild, and the teardown that closes the watcher with the server.
//
// The restart state machine itself (queueing during boot, build-before-close
// ordering, listen retries, the teardown races) is specced directly and
// mock-free in `_dev-restart.test.ts`. Only assertions that need the real
// wiring belong here — everything else pays a full bundler build per restart
// for coverage the supervisor spec gets in microseconds.
//
// No module mocks: `startDevServer` takes its watcher and its backend through
// `DevServerSeams`, so the fakes below are handed in rather than substituted
// for whole modules. Everything else — the bundler build, env resolution from
// the fixture's `.env`, agent validation — is the real code path.

import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type DevBackend, type DevServerSeams, startDevServer } from "./_dev-server.ts";
import { writeAgentTs } from "./_dev-server-test-utils.ts";
import type { DevWatchFn } from "./_dev-watch.ts";
import { withTempDir } from "./_test-utils.ts";

// 30s, not the 5s default: sibling suites run multi-second runtime-inlining
// builds now, and CPU starvation under full-repo parallel runs was flaking
// these otherwise-fast tests. The inner vi.waitFor ceilings below are 15s
// for the same reason — each restart runs a REAL bundler build, so a 1-2s
// bound that always holds standalone flakes under a contended `turbo run
// test`. waitFor settles as soon as the condition holds, so the generous
// ceiling costs nothing on the happy path.
vi.setConfig({ testTimeout: 30_000 });

// ─── Fakes ──────────────────────────────────────────────────────────────────

/**
 * A recording watcher plus backend, handed to `startDevServer` as its seams.
 *
 * `serve` records the RUNTIME options each build asks for — the journal
 * identity spec below reads them — and returns one shared fake backend, so
 * `listen`/`close` count across every rebuild.
 */
function makeSeams() {
  const listeners = new Map<string, (arg?: unknown) => void>();
  const watcherClose = vi.fn(async () => undefined);
  const watch = vi.fn<DevWatchFn>(() => ({
    on(event: string, listener: (arg?: unknown) => void) {
      listeners.set(event, listener);
    },
    close: watcherClose,
  }));
  const listen = vi.fn<DevBackend["listen"]>(async () => undefined);
  const close = vi.fn<DevBackend["close"]>(async () => undefined);
  const serve = vi.fn<DevServerSeams["serve"]>(() => ({ listen, close }));
  return {
    seams: { watch, serve } satisfies DevServerSeams,
    /** Fire a synthetic watcher change event, as chokidar's "all" does. */
    fireChange: () => listeners.get("all")?.(),
    /** Whether the watcher is up with its change listener attached. */
    watching: () => listeners.has("all"),
    watcherClose,
    listen,
    close,
    serve,
  };
}

/** The fixture project: a minimal `agent.ts`, and a key so env resolves. */
async function writeProject(dir: string): Promise<void> {
  await writeAgentTs(dir);
  await fs.writeFile(path.join(dir, ".env"), "ASSEMBLYAI_API_KEY=test-key\n");
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  // File watching defaults OFF without a TTY (see devWatchEnabled) — these
  // suites exercise the watcher, so they turn it on. `unstubEnvs` in
  // vitest.shared.ts undoes this before each test; no manual cleanup.
  vi.stubEnv("AAI_DEV_WATCH", "1");
  // `startDevServer` sets the workflow data dir with a plain assignment, which
  // `unstubEnvs` cannot undo on its own. Stubbing it unset RECORDS the
  // original, which the runner then restores before the next test.
  vi.stubEnv("AAI_WORKFLOW_DATA_DIR", undefined);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("startDevServer watch wiring", () => {
  test("a watcher change event drives a full rebuild and re-listen", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

      fake.close.mockClear();
      fake.serve.mockClear();
      fake.listen.mockClear();

      fake.fireChange();

      // Wait for the 300ms debounce + full async restart sequence
      await vi.waitFor(
        () => {
          expect(fake.close).toHaveBeenCalled();
          expect(fake.serve).toHaveBeenCalled();
          expect(fake.listen).toHaveBeenCalled();
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
   * runtime. Asserted as IDENTITY across the calls, because "built once" is the
   * property — a second journal is the bug whether or not the first one is
   * still reachable.
   */
  test("every rebuild's runtime gets the SAME journal, so a run survives a save", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);
      fake.fireChange();
      await vi.waitFor(() => expect(fake.serve.mock.calls.length).toBeGreaterThan(1), {
        timeout: 15_000,
      });

      const journals = fake.serve.mock.calls.map(([runtimeOptions]) => runtimeOptions.journal);
      expect(journals[0]).toBeDefined();
      for (const journal of journals) expect(journal).toBe(journals[0]);

      await cleanup();
    });
  });

  test("the watcher is installed before the initial listen", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeSeams();

      // Block startup at the initial listen and check the watcher is already
      // up: `ignoreInitial` means an edit saved during boot would otherwise
      // fire no event at all, and the dev server would serve stale code until
      // the next save. (That the event is then QUEUED rather than raced is the
      // supervisor's invariant, specced in _dev-restart.test.ts.)
      const initialListen = Promise.withResolvers<void>();
      fake.listen.mockImplementationOnce(() => initialListen.promise);

      const startPromise = startDevServer({ cwd: dir, port: 3000 }, fake.seams);
      // Reaching the initial listen runs a REAL bundler build, so the 1s
      // default holds standalone but flakes under a contended full-repo run.
      // Measured 2 failures in 5 five-project runs on the 1s bound versus 0
      // in 3 on the same commit's parent.
      await vi.waitFor(() => expect(fake.listen).toHaveBeenCalled(), { timeout: 15_000 });
      expect(fake.watching()).toBe(true);

      initialListen.resolve();
      await (await startPromise)();
    });
  });

  test("cleanup closes the watcher alongside the server, once", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);
      fake.close.mockClear();

      await cleanup();
      await cleanup();

      expect(fake.close).toHaveBeenCalledTimes(1);
      expect(fake.watcherClose).toHaveBeenCalledTimes(1);
    });
  });
});
