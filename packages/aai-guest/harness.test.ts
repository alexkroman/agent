// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the Node guest harness: one-shot tool trials, bundle loading,
 * request dispatch, runtime laziness, and upgrade auth pieces.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  bearerToken,
  dispatchMessage,
  ensureRuntime,
  type HarnessState,
  handleNotification,
  handleRequest,
} from "./harness.ts";
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
  vi.restoreAllMocks();
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
  return {
    agent: null,
    env: Object.freeze({}),
    storageEnabled: false,
    runtime: null,
    activeSessions: 0,
    studio: null,
    ...overrides,
  };
}

const TRIAL_OPTS = { storageEnabled: false, env: Object.freeze({}) };

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
      { storageEnabled: false, env: Object.freeze({ WHO: "world" }) },
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

describe("bundle/load + dispatch", () => {
  test("loads a bundle, reports its self-described config, and executes its tools", async () => {
    const state = makeState();
    const code = `
      export const __aaiConfig = { name: "from-bundle" };
      export default {
        name: "from-bundle",
        systemPrompt: "p",
        greeting: "g",
        tools: {
          greet: { description: "greet", execute: (args, ctx) => "hello " + ctx.env.WHO },
        },
      };
    `;
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "bundle/load",
        params: { code, env: { WHO: "world" }, storageEnabled: false },
      },
      state,
    );
    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true, config: { name: "from-bundle" } },
    });

    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tool/execute",
        params: { name: "greet", args: {}, sessionId: "s1", state: {} },
      },
      state,
    );
    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { result: "hello world", state: {} },
    });
  });

  test("a repeat bundle/load replaces the loaded agent", async () => {
    const state = makeState();
    const mk = (reply: string) =>
      `export default { name: "x", systemPrompt: "p", greeting: "g",
        tools: { t: { description: "t", execute: () => ${JSON.stringify(reply)} } } };`;
    await handleRequest(
      { jsonrpc: "2.0", id: 1, method: "bundle/load", params: { code: mk("v1"), env: {} } },
      state,
    );
    await handleRequest(
      { jsonrpc: "2.0", id: 2, method: "bundle/load", params: { code: mk("v2"), env: {} } },
      state,
    );
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tool/execute",
        params: { name: "t", args: {}, sessionId: "s", state: {} },
      },
      state,
    );
    expect((sent.at(-1) as { result: { result: string } }).result.result).toBe("v2");
  });

  test("a repeat bundle/load tears down the old runtime", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const state = makeState({
      runtime: { shutdown } as unknown as NonNullable<HarnessState["runtime"]>,
    });
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "bundle/load",
        params: {
          code: "export default { name: 'x', systemPrompt: 'p', greeting: 'g', tools: {} };",
          env: {},
        },
      },
      state,
    );
    expect(shutdown).toHaveBeenCalledOnce();
    // The next session builds a fresh runtime from the NEW bundle.
    expect(state.runtime).toBeNull();
  });

  test("bundle/load without code answers -32602", async () => {
    const state = makeState();
    await handleRequest({ jsonrpc: "2.0", id: 4, method: "bundle/load", params: {} }, state);
    expect((sent.at(-1) as { error: { code: number } }).error.code).toBe(-32_602);
  });

  test("tool/execute before any bundle answers Agent not loaded", async () => {
    const state = makeState();
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tool/execute",
        params: { name: "t", args: {}, sessionId: "s", state: {} },
      },
      state,
    );
    expect((sent.at(-1) as { error: { message: string } }).error.message).toBe("Agent not loaded");
  });

  test("status reports the live session count", async () => {
    const state = makeState({ activeSessions: 2 });
    await handleRequest({ jsonrpc: "2.0", id: 8, method: "status" }, state);
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 8, result: { activeSessions: 2 } });
  });

  test("unknown methods answer -32601", async () => {
    const state = makeState();
    await handleRequest({ jsonrpc: "2.0", id: 6, method: "wat" }, state);
    expect((sent.at(-1) as { error: { code: number } }).error.code).toBe(-32_601);
  });

  test("dispatchMessage settles a rejecting handler as -32603", async () => {
    const state = makeState();
    // A bundle whose module fails to import rejects inside handleRequest.
    dispatchMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "bundle/load",
        params: { code: "throw new Error('top-level boom')", env: {} },
      } as JsonRpcMessage,
      state,
    );
    await vi.waitFor(() => {
      const last = sent.at(-1) as { id?: number; error?: { code: number; message: string } };
      expect(last?.id).toBe(7);
      expect(last?.error?.code).toBe(-32_603);
      expect(last?.error?.message).toContain("top-level boom");
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

describe("ensureRuntime", () => {
  test("throws before any bundle is loaded", () => {
    expect(() => ensureRuntime(makeState())).toThrow("Agent not loaded");
  });

  test("is created once and reused across sessions", () => {
    const state = makeState({ agent: makeAgent() });
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
