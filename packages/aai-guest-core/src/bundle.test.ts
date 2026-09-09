// Copyright 2026 the AAI authors. MIT license.
/**
 * The bundle -> runtime lifecycle: loading, laziness, and `ensureRuntime`.
 *
 * Split out of `aai-guest/src/harness.test.ts` when this module moved into
 * `aai-guest-core`: coverage attributes a file to whoever LOADS it, so a
 * module whose only tests live in a dependent package reads as uncovered in
 * its own — which seeds a floor that cannot fail. A test follows its subject.
 */

import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ensureRuntime,
  type HarnessState,
  harnessBundleDir,
  lazyRuntime,
  loadBundle,
} from "./bundle.ts";
import { rejectAllPendingHostRequests, setHostSend } from "./rpc.ts";
import {
  FAKE_RUNTIME_EXPORT,
  fakeSocket,
  installFakeHostChannel,
  makeAgent,
  makeState,
} from "./test-utils.ts";
import { executeTool } from "./trial.ts";
import type { AgentDef } from "./types.ts";

beforeEach(() => {
  installFakeHostChannel();
});

afterEach(() => {
  rejectAllPendingHostRequests("test teardown");
  setHostSend(null);
});

describe("loadBundle", () => {
  test("loads a bundle, reports its self-described config, and executes its tools", async () => {
    const state = makeState();
    const code = `
      export const __aaiConfig = { name: "from-bundle" };
      ${FAKE_RUNTIME_EXPORT}
      export default {
        name: "from-bundle",
        systemPrompt: "p",
        greeting: "g",
        tools: {
          greet: { description: "greet", execute: (args, ctx) => "hello " + ctx.env.WHO },
        },
      };
    `;
    const loaded = await loadBundle(state, { code, env: { WHO: "world" } });
    expect(loaded).toEqual({ config: { name: "from-bundle" } });

    const agent = state.agent;
    expect(agent).not.toBeNull();
    const res = await executeTool(
      agent as AgentDef,
      { name: "greet", args: {}, sessionId: "s1", state: {} },
      { env: state.env },
    );
    expect(res).toEqual({ result: "hello world", state: {} });
  });

  test("the bundle is written beside the HARNESS, which is what anchors its requires", async () => {
    // WHY the location matters: the bundled SDK's CJS interop anchors
    // `createRequire` on the bundle file's own URL, and the Workflow DevKit picks
    // its world by `require`ing a package NAME, which no bundler can inline. From
    // `tmpdir()`, as this used to be, there is no `node_modules` above it — a
    // durable workflow agent died on `Cannot find module
    // '@workflow/world-postgres'` with a require stack naming a path in `/T/`.
    //
    // The LOCATION is asserted rather than the resolution, and the reason is a
    // property of this tier rather than a preference: vitest patches
    // `createRequire`, so `resolve` succeeds from ANY directory here and the real
    // failure cannot be provoked (the same trap this package's guide records for
    // `loadTransformer`). A resolve-based version of this test passed with the fix
    // reverted — verified — so it would have been decoration. What is provable
    // here is where the file goes, which is the half under our control.
    //
    // The bundle reports its own `import.meta.dirname` through `__aaiConfig`: a
    // path the test computed would only prove what the loader was told, where this
    // proves what the loaded module sees.
    const state = makeState();
    const code = `
      export const __aaiConfig = { dir: import.meta.dirname };
      ${FAKE_RUNTIME_EXPORT}
      export default { name: "x", systemPrompt: "p", greeting: "g" };`;

    const loaded = await loadBundle(state, { code, env: {} });

    // The directory `harness/bundle.ts` itself lives in — `dist/` beside
    // `harness.mjs` once bundled, this package's root when running from source.
    const { dir } = (loaded as { config: { dir: string } }).config;
    expect(dir).toBe(harnessBundleDir());
    expect(dir).not.toBe(tmpdir());
  });

  test("a repeat load replaces the loaded agent", async () => {
    const state = makeState();
    const mk = (reply: string) =>
      `${FAKE_RUNTIME_EXPORT}
      export default { name: "x", systemPrompt: "p", greeting: "g",
        tools: { t: { description: "t", execute: () => ${JSON.stringify(reply)} } } };`;
    await loadBundle(state, { code: mk("v1"), env: {} });
    await loadBundle(state, { code: mk("v2"), env: {} });
    const res = await executeTool(
      state.agent as AgentDef,
      { name: "t", args: {}, sessionId: "s", state: {} },
      { env: state.env },
    );
    expect(res.result).toBe("v2");
  });

  test("a repeat load tears down the old runtime", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const state = makeState({
      runtime: { shutdown } as unknown as NonNullable<HarnessState["runtime"]>,
    });
    await loadBundle(state, {
      code: `${FAKE_RUNTIME_EXPORT}
        export default { name: 'x', systemPrompt: 'p', greeting: 'g', tools: {} };`,
      env: {},
    });
    expect(shutdown).toHaveBeenCalledOnce();
    // The next session builds a fresh runtime from the NEW bundle.
    expect(state.runtime).toBeNull();
  });

  // Each load wrote ~8 MB into tmpdir under a unique name and nothing ever
  // removed it, while the tool description tells the coding agent to run
  // `test_agent` after every meaningful change — in a sandbox that lives for
  // hours.
  test("the temp module a bundle is imported from does not survive the import", async () => {
    const bundles = async () =>
      (await readdir(tmpdir())).filter((f) => f.startsWith(`aai-bundle-${process.pid}-`));
    const before = (await bundles()).length;
    const state = makeState();
    await loadBundle(state, {
      code: `${FAKE_RUNTIME_EXPORT}
        export default { name: 'x', systemPrompt: 'p', greeting: 'g', tools: {} };`,
      env: {},
    });
    expect(state.agent).not.toBeNull();
    expect((await bundles()).length).toBe(before);
  });

  test("a failed load leaves no temp module behind either", async () => {
    const bundles = async () =>
      (await readdir(tmpdir())).filter((f) => f.startsWith(`aai-bundle-${process.pid}-`));
    const before = (await bundles()).length;
    await expect(
      loadBundle(makeState(), { code: "this is not valid javascript ===", env: {} }),
    ).rejects.toThrow();
    expect((await bundles()).length).toBe(before);
  });

  test("a bundle without __aaiCreateRuntime is rejected at load", async () => {
    const state = makeState();
    await expect(
      loadBundle(state, {
        code: "export default { name: 'x', systemPrompt: 'p', greeting: 'g', tools: {} };",
        env: {},
      }),
    ).rejects.toThrow("__aaiCreateRuntime");
    // Nothing was installed — the next session cannot run stale state.
    expect(state.agent).toBeNull();
  });
});

describe("lazyRuntime", () => {
  test("a refusal closes the socket with the hook's code and starts nothing", () => {
    const state = makeState();
    const runtime = lazyRuntime(state, {
      refuse: () => ({ code: 1013, reason: "draining" }),
    });
    const ws = fakeSocket();

    runtime.startSession(ws);

    expect(ws.closes).toEqual([{ code: 1013, reason: "draining" }]);
    expect(state.activeSessions).toBe(0);
  });

  test("with no bundle loaded, the session is answered with a 1011 close naming the cause", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = makeState();
    const ws = fakeSocket();

    lazyRuntime(state).startSession(ws);

    expect(ws.closes).toEqual([{ code: 1011, reason: "Agent not loaded" }]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("session refused"));
  });

  test("builds the runtime on the FIRST session, delegates, and counts live sessions", () => {
    const started: unknown[] = [];
    let builds = 0;
    const state = makeState({
      agent: makeAgent(),
      createRuntime: () => {
        builds++;
        return {
          startSession: (ws) => started.push(ws),
          shutdown: () => Promise.resolve(),
        };
      },
    });
    const runtime = lazyRuntime(state);
    const first = fakeSocket();
    const second = fakeSocket();

    runtime.startSession(first);
    runtime.startSession(second);

    expect(builds).toBe(1); // lazy AND memoized — one runtime for all sessions
    expect(started).toEqual([first, second]);
    expect(state.activeSessions).toBe(2);

    first.emit("close");
    expect(state.activeSessions).toBe(1);
    second.emit("close");
    // A second close of the same socket must never push the count negative.
    second.emit("close");
    expect(state.activeSessions).toBe(0);
  });

  test("shutdown forwards to the live runtime and is a no-op before one exists", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const state = makeState();
    await lazyRuntime(state).shutdown(); // nothing built yet — must not throw
    state.runtime = { startSession: () => undefined, shutdown };
    await lazyRuntime(state).shutdown();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});

describe("ensureRuntime", () => {
  test("throws before any bundle is loaded", () => {
    expect(() => ensureRuntime(makeState())).toThrow("Agent not loaded");
  });

  test("is created once and reused across sessions", () => {
    const state = makeState({
      agent: makeAgent(),
      createRuntime: () => ({ startSession: () => undefined, shutdown: () => Promise.resolve() }),
    });
    const first = ensureRuntime(state);
    expect(state.runtime).toBe(first);
    expect(ensureRuntime(state)).toBe(first);
    void first.shutdown().catch(() => undefined);
  });
});
