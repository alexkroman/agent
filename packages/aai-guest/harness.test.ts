// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the Node guest harness: one-shot tool trials, bundle loading,
 * request dispatch, runtime laziness, and upgrade auth pieces.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dispatchMessage, handleNotification, handleRequest, lazyRuntime } from "./harness.ts";
import { bearerToken } from "./harness-auth.ts";
import {
  emptyHarnessState,
  ensureRuntime,
  type HarnessState,
  loadBundle,
} from "./harness-bundle.ts";
import { rejectAllPendingHostRequests, setHostSend } from "./harness-rpc.ts";
import type { AgentDef, JsonRpcMessage } from "./harness-types.ts";
import { executeTool } from "./trial.ts";

let sent: JsonRpcMessage[];

beforeEach(() => {
  sent = [];
  setHostSend((msg) => sent.push(msg));
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

  test("ctx.db throws storage guidance when storage is disabled", async () => {
    const agent = makeAgent({
      tools: {
        usesDb: {
          description: "touch ctx.db",
          execute: (_args, ctx) => ctx.db.query("select 1"),
        },
      },
    });
    const res = await executeTool(
      agent,
      { name: "usesDb", args: {}, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res.error).toContain("Storage is not enabled");
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
    expect((sent.at(-1) as { error: { code: number } }).error.code).toBe(-32_601);
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
      const last = sent.at(-1) as { id?: number; error?: { code: number; message: string } };
      expect(last?.id).toBe(7);
      expect(last?.error?.code).toBe(-32_603);
      expect(last?.error?.message).toContain("escapes the workspace");
    });
  });

  test("shutdown notification exits the process", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    handleNotification({ jsonrpc: "2.0", method: "shutdown" });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test("malformed notifications are ignored", () => {
    expect(() => handleNotification({ jsonrpc: "2.0" } as never)).not.toThrow();
  });
});

describe("control-channel param validation", () => {
  test("workspace/deploy with invalid params answers -32602 naming the method", async () => {
    const state = makeState();
    await handleRequest(
      { jsonrpc: "2.0", id: 8, method: "workspace/deploy", params: { files: "not-a-map" } },
      state,
    );
    const last = sent.at(-1) as { id: number; error: { code: number; message: string } };
    expect(last.id).toBe(8);
    expect(last.error.code).toBe(-32_602);
    expect(last.error.message).toContain("workspace/deploy: invalid params");
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
    const last = sent.at(-1) as { id: number; error: { code: number; message: string } };
    expect(last.id).toBe(9);
    expect(last.error.code).toBe(-32_602);
    expect(last.error.message).toContain("studio/session-init: invalid params");
    expect(state.studio).toBeNull();
  });
});

/** A fake session socket: records closes, replays close events. */
function fakeSocket() {
  const listeners = new Map<string, () => void>();
  return {
    closes: [] as { code: number; reason: string }[],
    close(code: number, reason: string) {
      this.closes.push({ code, reason });
    },
    on(event: string, fn: () => void) {
      listeners.set(event, fn);
    },
    emit(event: string) {
      listeners.get(event)?.();
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

    runtime.startSession(ws as never, {} as never);

    expect(ws.closes).toEqual([{ code: 1013, reason: "draining" }]);
    expect(state.activeSessions).toBe(0);
  });

  test("with no bundle loaded, the session is answered with a 1011 close naming the cause", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = makeState();
    const ws = fakeSocket();

    lazyRuntime(state).startSession(ws as never, {} as never);

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

    runtime.startSession(first as never, {} as never);
    runtime.startSession(second as never, {} as never);

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

  test("rejects missing or non-Bearer headers", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });
});
