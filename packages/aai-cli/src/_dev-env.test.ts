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
 * The cases are unchanged; they drive `startDevServer` because that is where an
 * env var has to arrive to matter — a unit test of `devBindHost()` asserts the
 * parse and not that anything passes the result to `listen`.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
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

import { createDevLogger } from "./_dev-env.ts";
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
