// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the Node guest harness: one-shot tool trials, bundle loading,
 * request dispatch, runtime laziness, and upgrade auth pieces.
 */

import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WS_OPEN } from "@alexkroman1/aai/host-internal";
import type { SessionWebSocket } from "@alexkroman1/aai-runtime";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type FakeHostChannel, installFakeHostChannel } from "./_test-utils.ts";
import { dispatchMessage, handleNotification, handleRequest } from "./harness.ts";
import { bearerToken } from "./harness-auth.ts";
import {
  emptyHarnessState,
  ensureRuntime,
  type HarnessState,
  harnessBundleDir,
  lazyRuntime,
  loadBundle,
} from "./harness-bundle.ts";
import { hostRequest, rejectAllPendingHostRequests, setHostSend } from "./harness-rpc.ts";
import type { AgentDef, JsonRpcMessage } from "./harness-types.ts";
import { executeTool, runCode } from "./trial.ts";

let host: FakeHostChannel;
let sent: FakeHostChannel["sent"];

beforeEach(() => {
  host = installFakeHostChannel();
  sent = host.sent;
});

afterEach(() => {
  rejectAllPendingHostRequests("test teardown");
  setHostSend(null);
});

function makeAgent(overrides?: Partial<AgentDef>): AgentDef {
  return {
    name: "t",
    systemPrompt: "p",
    greeting: "g",
    tools: {
      echo: {
        description: "echo",
        execute: (args) => `echo:${(args as { text: string }).text}`,
      },
      mutate: {
        description: "bump ctx.state.count",
        execute: (_args, ctx) => {
          const state = ctx.state as { count?: number };
          state.count = (state.count ?? 0) + 1;
          return `count=${state.count}`;
        },
      },
      explode: {
        description: "always throws",
        execute: () => {
          throw new Error("kaboom");
        },
      },
    },
    ...overrides,
  };
}

function makeState(overrides?: Partial<HarnessState>): HarnessState {
  return { ...emptyHarnessState(), ...overrides };
}

/**
 * The factory export every real bundle carries (the CLI wrapper bundles the
 * user's SDK runtime behind it) — the fixture version returns an inert
 * two-method runtime, which is all the harness contract demands.
 */
const FAKE_RUNTIME_EXPORT = `export const __aaiCreateRuntime = () =>
  ({ startSession: () => undefined, shutdown: () => Promise.resolve() });`;

const TRIAL_OPTS = { env: Object.freeze({}) };

describe("executeTool (one-shot trial)", () => {
  test("runs a tool and returns result + state", async () => {
    const res = await executeTool(
      makeAgent(),
      { name: "echo", args: { text: "hi" }, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res).toEqual({ result: "echo:hi", state: {} });
  });

  test("initializes state from the agent factory when state is null", async () => {
    const agent = makeAgent({ state: () => ({ count: 10 }) });
    const res = await executeTool(
      agent,
      { name: "mutate", args: {}, sessionId: "s1", state: null },
      TRIAL_OPTS,
    );
    expect(res.result).toBe("count=11");
    expect(res.state).toEqual({ count: 11 });
  });

  test("mutations to shipped state ride back on the response", async () => {
    const res = await executeTool(
      makeAgent(),
      { name: "mutate", args: {}, sessionId: "s1", state: { count: 5 } },
      TRIAL_OPTS,
    );
    expect(res.state).toEqual({ count: 6 });
  });

  test("a throwing tool returns error AND state", async () => {
    const res = await executeTool(
      makeAgent(),
      { name: "explode", args: {}, sessionId: "s1", state: { seen: true } },
      TRIAL_OPTS,
    );
    expect(res.error).toBe("kaboom");
    expect(res.state).toEqual({ seen: true });
  });

  test("unknown tool returns an error, not a throw", async () => {
    const res = await executeTool(
      makeAgent(),
      { name: "nope", args: {}, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res.error).toBe("Unknown tool: nope");
  });

  test("invalid args surface as a tool error the LLM can repair", async () => {
    const agent = makeAgent({
      tools: {
        strict: {
          description: "strict params",
          parameters: {
            parse: () => {
              throw new Error("bad args");
            },
          },
          execute: () => "never",
        },
      },
    });
    const res = await executeTool(
      agent,
      { name: "strict", args: { wrong: true }, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res.error).toBe("bad args");
  });

  test("run_code executes in the guest and captures console output", async () => {
    const res = await executeTool(
      makeAgent(),
      {
        name: "run_code",
        args: { code: "console.log('a', 1); console.log(2)" },
        sessionId: "s1",
        state: {},
      },
      TRIAL_OPTS,
    );
    expect(res.result).toBe("a 1\n2");
  });

  test("run_code reports thrown errors", async () => {
    const res = await executeTool(
      makeAgent(),
      { name: "run_code", args: { code: "throw new Error('nope')" }, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res.error).toBe("nope");
  });

  // The wedge: an async IIFE runs synchronously to its first `await`, and code
  // with no `await` never yields — so the in-thread timer that was supposed to
  // stop it could not be reached to fire, and the guest burned to Modal's
  // lifetime cap with `/health` unanswered.
  test("run_code terminates code that never yields, instead of wedging the guest", async () => {
    const res = await runCode("while (true) {}", 250);
    expect(res).toMatchObject({ error: expect.stringContaining("timed out") });
    // A promise race would have "returned" here too — and left the loop running.
    // The proof that the thread is gone is that the next call still answers.
    // (A wall-clock `Date.now()` bound used to sit here as well. It asserted
    // nothing this line does not: a surviving spin loop starves the pool and
    // the second call never resolves, which the suite timeout reports. What it
    // added was a failure mode of its own on a loaded runner.)
    expect(await runCode("console.log('still alive')", 5000)).toBe("still alive");
  });

  test("run_code output survives the hop back from the worker", async () => {
    expect(await runCode("console.log({ a: 1 }); console.error('and stderr')")).toBe(
      "[object Object]\nand stderr",
    );
  });

  test("a tool reaching for ctx.db fails, because the field does not exist", async () => {
    // This used to assert a curated "no database is configured" message. `ctx.db`
    // is gone entirely — the platform hands tool code no database — so what a tool
    // written against the old API gets is a TypeError. Asserted rather than
    // deleted: failing LOUDLY is the contract, not reading `undefined` and moving
    // on.
    const agent = makeAgent({
      tools: {
        usesDb: {
          description: "touch ctx.db",
          execute: (_args, ctx) => {
            const reached = (ctx as { db?: { query(s: string): Promise<unknown> } }).db;
            // No non-null assertion: the point is that the field is ABSENT, and a
            // `!` would assert the opposite of what this spec claims.
            if (!reached) throw new Error("ctx.db is gone");
            return reached.query("select 1");
          },
        },
      },
    });
    const res = await executeTool(
      agent,
      { name: "usesDb", args: {}, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res.error).toBeTruthy();
  });

  test("ctx.env carries the loaded env into tool code", async () => {
    const agent = makeAgent({
      tools: {
        readsEnv: {
          description: "reads env",
          execute: (_args, ctx) => `who=${ctx.env.WHO}`,
        },
      },
    });
    const res = await executeTool(
      agent,
      { name: "readsEnv", args: {}, sessionId: "s1", state: {} },
      { env: Object.freeze({ WHO: "world" }) },
    );
    expect(res.result).toBe("who=world");
  });

  test("ctx.send is a silent no-op in trial runs (no connected client)", async () => {
    const agent = makeAgent({
      tools: {
        notifies: {
          description: "sends to client",
          execute: (_args, ctx) => {
            ctx.send("evt", { x: 1 });
            return "sent";
          },
        },
      },
    });
    const res = await executeTool(
      agent,
      { name: "notifies", args: {}, sessionId: "s9", state: {} },
      TRIAL_OPTS,
    );
    expect(res.result).toBe("sent");
    expect(sent).toEqual([]);
  });
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

    // The directory `harness-bundle.ts` itself lives in — `dist/` beside
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

describe("control-channel dispatch", () => {
  // Covers removed methods too: `bundle/load`, `tool/execute`, and `status`
  // all left the channel and fall to the same method-not-found branch.
  test("unknown methods answer -32601", async () => {
    const state = makeState();
    await handleRequest({ jsonrpc: "2.0", id: 6, method: "bundle/load" }, state);
    expect(host.lastResponse().error?.code).toBe(-32_601);
  });

  test("dispatchMessage settles a rejecting handler as -32603", async () => {
    const state = makeState();
    // workspace/deploy validates its param shape inline, then rejects on the
    // path-escape guard in materializeWorkspace — the cheapest real
    // rejection left on the channel.
    dispatchMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "workspace/deploy",
        params: { files: { "../escape": "x" }, serverUrl: "http://s", apiKey: "k" },
      } as JsonRpcMessage,
      state,
    );
    await vi.waitFor(() => {
      const last = host.lastResponse();
      expect(last.id).toBe(7);
      expect(last.error?.code).toBe(-32_603);
      expect(last.error?.message).toContain("escapes the workspace");
    });
  });

  // `dispatchMessage` routes on the SHAPE of the frame, and the two branches
  // below are the ones a request-shaped test cannot reach: a frame with an `id`
  // and no `method` is an answer to something the guest asked, and a frame with
  // a `method` and no `id` is a notification. Getting either wrong sends a
  // response into the request handler, where it answers -32601 to the host and
  // strands the promise nobody ever settles.
  test("a frame with an id and no method settles the host request it answers", async () => {
    const pending = hostRequest("studio/sync-workspace", {}, 5000);
    const asked = sent.at(-1) as { id: number };

    dispatchMessage(
      { jsonrpc: "2.0", id: asked.id, result: { ok: true } } as JsonRpcMessage,
      makeState(),
    );

    await expect(pending).resolves.toEqual({ ok: true });
  });

  test("a frame with a method and no id is a notification, not a request", () => {
    const before = sent.length;

    dispatchMessage(
      { jsonrpc: "2.0", method: "not-a-real-notification" } as JsonRpcMessage,
      makeState(),
    );

    // An unknown NOTIFICATION is dropped in silence — answering it would be
    // answering a frame that carries no id to answer.
    expect(sent).toHaveLength(before);
  });

  test("shutdown notification exits the process", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    handleNotification({ jsonrpc: "2.0", method: "shutdown" });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test("malformed notifications are ignored", () => {
    expect(() => handleNotification({ jsonrpc: "2.0" })).not.toThrow();
  });
});

describe("control-channel param validation", () => {
  test("workspace/deploy with invalid params answers -32602 naming the method", async () => {
    const state = makeState();
    await handleRequest(
      { jsonrpc: "2.0", id: 8, method: "workspace/deploy", params: { files: "not-a-map" } },
      state,
    );
    const last = host.lastResponse();
    expect(last.id).toBe(8);
    expect(last.error?.code).toBe(-32_602);
    expect(last.error?.message).toContain("workspace/deploy: invalid params");
  });

  test("studio/session-init with invalid params answers -32602 without installing a session", async () => {
    const state = makeState();
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "studio/session-init",
        // chatToken must be non-empty and maxSteps a positive integer.
        params: {
          project: "p",
          files: {},
          apiKey: "k",
          chatToken: "",
          system: "s",
          model: "m",
          maxSteps: 0,
        },
      },
      state,
    );
    const last = host.lastResponse();
    expect(last.id).toBe(9);
    expect(last.error?.code).toBe(-32_602);
    expect(last.error?.message).toContain("studio/session-init: invalid params");
    expect(state.studio).toBeNull();
  });
});

/**
 * The one event shape {@link fakeSocket} replays. An INTERSECTION of what
 * `SessionWebSocket`'s four `addEventListener` overloads hand their listeners,
 * which is what lets one implementation satisfy all four — a per-overload
 * implementation signature needs an `any` (see `_mock-ws.ts`), and narrowing
 * the socket at the call site is the `as never` this replaced.
 */
type FrameEvent = { code?: number; reason?: string } & { data: unknown } & { message?: string };

/**
 * A fake session socket: records closes, replays close events.
 *
 * Structurally a {@link SessionWebSocket}, so the `startSession` calls below
 * need no cast — which is also the assertion that `lazyRuntime` touches only
 * the socket contract the runtime really promises it.
 */
function fakeSocket(): SessionWebSocket & {
  closes: { code: number; reason: string }[];
  emit(type: string): void;
} {
  const listeners = new Map<string, (event: FrameEvent) => void>();
  const closes: { code: number; reason: string }[] = [];
  const addEventListener: SessionWebSocket["addEventListener"] = (
    type: string,
    listener: (event: FrameEvent) => void,
  ) => {
    listeners.set(type, listener);
  };
  return {
    readyState: WS_OPEN,
    closes,
    close(code?: number, reason?: string) {
      closes.push({ code: code ?? 0, reason: reason ?? "" });
    },
    send() {
      // Nothing here reads what a session sends; the socket is a close recorder.
    },
    addEventListener,
    emit(type: string) {
      listeners.get(type)?.({ code: 1000, reason: "", data: null, message: "" });
    },
  };
}

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

describe("bearerToken", () => {
  test("extracts the token from a Bearer header", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
  });

  // The FAILING observation. Against `header?.startsWith("Bearer ")` both of
  // these were `null`, so a client sending the spec-legal
  // `authorization: bearer <token>` was refused by the `/ws` control channel and
  // by the studio chat surface alike — a 401 whose sentence named a missing or
  // invalid token rather than a capitalisation. The old spec here asserted only
  // the one capitalisation this repo happens to send, so it agreed with the bug
  // without pinning it; `aai-server/_bearer.test.ts` had gone one step further
  // and asserted the bug as correct.
  test.each(["bearer", "BEARER", "BeArEr"])(
    "accepts the %s scheme too, per RFC 7235 §2.1",
    (scheme) => {
      expect(bearerToken(`${scheme} abc123`)).toBe("abc123");
    },
  );

  test("accepts the extra spaces `auth-scheme 1*SP token68` permits", () => {
    expect(bearerToken("Bearer  abc123")).toBe("abc123");
  });

  test("rejects missing or non-Bearer headers", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    // A scheme with no credential is not a credential — `null`, not `""`, so
    // `verifyBearer`'s length check is not the only thing standing between an
    // empty parse and a comparison.
    expect(bearerToken("Bearer ")).toBeNull();
  });
});
