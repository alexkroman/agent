// Copyright 2026 the AAI authors. MIT license.
/**
 * `_dev-env.ts`, which had no spec of its own.
 *
 * Its four exports are how `aai dev` reads its environment — the bind host, the
 * host-mode gate, the watch flag, and the logger that keeps the runtime's
 * diagnostics off the one stdout line `--json` writes. Three of them were
 * covered from `_dev-server.test.ts`, under names describing the SERVER, which
 * is how a 700-line file gets to 699 and how a module ends up looking untested
 * while its behaviour is pinned two files over.
 *
 * Most cases drive `startDevServer`, because that is where an env var has to
 * arrive to matter — a unit test of `devBindHost()` asserts the parse and not
 * that anything passes the result to `listen`. `devWatchEnabled` is the one
 * split in two: its DECISION is a three-way answer over a flag, a variable and
 * a TTY pair, which is cheaper and clearer to state directly, and two wiring
 * cases below assert the answer really reaches chokidar.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  mockChokidarWatch,
  mockCreateServer,
  mockListen,
  primeDevServerMocks,
  writeAgentTs,
} from "./_dev-server-test-utils.ts";
import { withTempDir } from "./_test-utils.ts";

// ─── Module mocks ───────────────────────────────────────────────────────────
// Factories (and the mock fns/state they wire up) live in the shared harness —
// see _dev-server-test-utils.ts. vi.mock calls must stay top-level in each test
// file for vitest's hoisting, which is why this preamble is duplicated rather
// than shared.

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

import { createDevLogger, devWatchEnabled } from "./_dev-env.ts";
import { startDevServer } from "./_dev-server.ts";

// 30s, not the 5s default: sibling suites run multi-second runtime-inlining
// builds now, and CPU starvation under full-repo parallel runs was flaking
// these otherwise-fast tests.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  primeDevServerMocks();
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

/**
 * Pretend a person is (or is not) at the terminal.
 *
 * `isTTY` is a plain value property on both streams, so there is no getter to
 * spy on — it is defined and restored, which is also what keeps one spec's
 * pretend terminal out of the next one's.
 */
function withTtys<T>(stdin: boolean, stdout: boolean, fn: () => T): T {
  const original = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
  const set = (value: { stdin: boolean | undefined; stdout: boolean | undefined }): void => {
    Object.defineProperty(process.stdin, "isTTY", { value: value.stdin, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: value.stdout, configurable: true });
  };
  set({ stdin, stdout });
  try {
    return fn();
  } finally {
    set(original);
  }
}

describe("devWatchEnabled", () => {
  /**
   * Watching was OPT-IN, and the quickstart's own recommended command was
   * `aai dev --watch` — so the default loop needed a manual restart per edit
   * while the guide shipped into every scaffolded project promised hot reload.
   * The argument for opt-in was real and is unchanged: a restart ends in-flight
   * voice sessions, which is wrong while a benchmark drives the host for twenty
   * minutes. It is an argument about a HARNESS, and the two TTYs are what
   * narrow it to one — the same discriminator `cli.ts` uses before an implicit
   * publish.
   */
  test("a person at a terminal gets watching with nothing set", () => {
    vi.stubEnv("AAI_DEV_WATCH", "");
    expect(withTtys(true, true, () => devWatchEnabled())).toBe(true);
  });

  test.each([
    ["a piped stdout", true, false],
    ["a piped stdin", false, true],
    ["neither", false, false],
  ])("%s keeps the old behaviour — no watching", (_label, stdin: boolean, stdout: boolean) => {
    // A harness or a supervisor spawning `aai dev` has neither, which is also
    // what auto-selects JSON mode. So the benchmark case is preserved by
    // construction rather than by knowing a variable exists.
    vi.stubEnv("AAI_DEV_WATCH", "");
    expect(withTtys(stdin, stdout, () => devWatchEnabled())).toBe(false);
  });

  test("AAI_DEV_WATCH=0 turns it OFF at a terminal", () => {
    // It used to work by coincidence: every value but the four truthy ones fell
    // through to a default of off, so nothing READ the zero. With the default
    // on, the variable has to decide whenever it carries a value.
    vi.stubEnv("AAI_DEV_WATCH", "0");
    expect(withTtys(true, true, () => devWatchEnabled())).toBe(false);
  });

  test("AAI_DEV_WATCH=1 turns it ON with no terminal, for a process supervisor", () => {
    vi.stubEnv("AAI_DEV_WATCH", "1");
    expect(withTtys(false, false, () => devWatchEnabled())).toBe(true);
  });

  test.each([true, false])("--watch=%s wins over everything", (flag: boolean) => {
    vi.stubEnv("AAI_DEV_WATCH", flag ? "0" : "1");
    expect(withTtys(!flag, !flag, () => devWatchEnabled(flag))).toBe(flag);
  });
});

describe("dev server file watching", () => {
  // The wiring, not the decision: an env var (or a TTY) has to reach chokidar
  // to matter, and `startDevServer` is where that happens.
  test("a TTY pair installs the watcher", async () => {
    vi.stubEnv("AAI_DEV_WATCH", "");
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      const cleanup = await withTtys(true, true, () => startDevServer({ cwd: dir, port: 3000 }));
      expect(mockChokidarWatch).toHaveBeenCalled();
      await cleanup();
    });
  });

  test("no terminal installs none, and teardown survives its absence", async () => {
    // `watcher?.close()` — without the optional call every shutdown threw
    // "Cannot read properties of undefined (reading 'close')".
    vi.stubEnv("AAI_DEV_WATCH", "");
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      const cleanup = await withTtys(false, false, () => startDevServer({ cwd: dir, port: 3000 }));
      expect(mockChokidarWatch).not.toHaveBeenCalled();
      await expect(cleanup()).resolves.toBeUndefined();
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
