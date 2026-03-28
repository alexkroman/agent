// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared runtime conformance tests.
 *
 * Both the self-hosted direct executor and the platform sandbox must satisfy
 * the same behavioral contract. This module defines that contract as a
 * reusable test suite that can be wired to either runtime.
 *
 * Inspired by Nitro's `testNitro()` pattern: one test fixture, many runtimes.
 *
 * @example Direct executor (unit test)
 * ```ts
 * import { testRuntime } from "./_runtime-conformance.ts";
 *
 * testRuntime("direct", () => {
 *   const exec = createDirectExecutor({ agent: CONFORMANCE_AGENT, env: { MY_VAR: "test-value" } });
 *   return { executeTool: exec.executeTool, hookInvoker: exec.hookInvoker };
 * });
 * ```
 *
 * @example Sandbox (integration test)
 * ```ts
 * import { testRuntime, CONFORMANCE_AGENT_BUNDLE } from "@alexkroman1/aai/runtime-conformance";
 *
 * testRuntime("sandbox", async () => {
 *   // ... start isolate with CONFORMANCE_AGENT_BUNDLE
 *   return { executeTool: buildExecuteTool(...), hookInvoker: buildHookInvoker(...) };
 * });
 * ```
 */

import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { HookInvoker } from "./middleware.ts";
import { type AgentDef, defineTool } from "./types.ts";
import type { ExecuteTool } from "./worker-entry.ts";

// ── Shared context type ────────────────────────────────────────────────────

/**
 * Minimal runtime surface needed for conformance tests.
 *
 * Both `DirectExecutor` and `buildExecuteTool`/`buildHookInvoker` from the
 * sandbox produce objects that satisfy this interface.
 */
export type RuntimeTestContext = {
  executeTool: ExecuteTool;
  hookInvoker: HookInvoker;
};

// ── Conformance agent ──────────────────────────────────────────────────────

/**
 * Agent definition used by the conformance suite (direct executor path).
 *
 * Must be kept in sync with {@link CONFORMANCE_AGENT_BUNDLE}.
 */
export const CONFORMANCE_AGENT: AgentDef = {
  name: "conformance-test",
  instructions: "Conformance test agent.",
  greeting: "Hello!",
  maxSteps: 5,
  state: () => ({ count: 0, lastTurn: "" }),
  tools: {
    echo: defineTool({
      description: "Echo input",
      parameters: z.object({ text: z.string() }),
      execute: ({ text }) => `echo:${text}`,
    }),
    get_env: {
      description: "Get MY_VAR from env",
      execute: (_args: unknown, ctx) => ctx.env.MY_VAR ?? "missing",
    },
    get_state: {
      description: "Get session state",
      execute: (_args: unknown, ctx) => JSON.stringify(ctx.state),
    },
    echo_messages: {
      description: "Return messages as JSON",
      execute: (_args: unknown, ctx) => JSON.stringify(ctx.messages),
    },
    kv_roundtrip: defineTool({
      description: "KV set then get",
      parameters: z.object({ value: z.string() }),
      execute: async ({ value }, ctx) => {
        await ctx.kv.set("test-key", value);
        const result = await ctx.kv.get<string>("test-key");
        return `stored:${JSON.stringify(result)}`;
      },
    }),
  },
  onConnect: (ctx) => {
    (ctx.state as { count: number }).count = 1;
  },
  onTurn: (text: string, ctx) => {
    (ctx.state as { lastTurn: string }).lastTurn = text;
  },
};

/**
 * JavaScript bundle equivalent of {@link CONFORMANCE_AGENT} for the sandbox
 * isolate path. Must be kept in sync with the AgentDef above.
 */
export const CONFORMANCE_AGENT_BUNDLE = `
export default {
  name: "conformance-test",
  instructions: "Conformance test agent.",
  greeting: "Hello!",
  maxSteps: 5,
  state: () => ({ count: 0, lastTurn: "" }),
  tools: {
    echo: {
      description: "Echo input",
      execute(args) { return "echo:" + args.text; },
    },
    get_env: {
      description: "Get MY_VAR from env",
      execute(_args, ctx) { return ctx.env.MY_VAR ?? "missing"; },
    },
    get_state: {
      description: "Get session state",
      execute(_args, ctx) { return JSON.stringify(ctx.state); },
    },
    echo_messages: {
      description: "Return messages as JSON",
      execute(_args, ctx) { return JSON.stringify(ctx.messages); },
    },
    kv_roundtrip: {
      description: "KV set then get",
      async execute(args, ctx) {
        await ctx.kv.set("test-key", args.value);
        const result = await ctx.kv.get("test-key");
        return "stored:" + JSON.stringify(result);
      },
    },
  },
  onConnect: (ctx) => { ctx.state.count = 1; },
  onTurn: (text, ctx) => { ctx.state.lastTurn = text; },
};
`;

// ── Shared conformance suite ───────────────────────────────────────────────

/**
 * Run the runtime conformance test suite against a given runtime context.
 *
 * The `getContext` callback is invoked once per test to retrieve the
 * current {@link RuntimeTestContext}. This allows the caller to set up
 * the runtime in a `beforeAll` and return it lazily.
 *
 * All tests assume the runtime was created with {@link CONFORMANCE_AGENT}
 * (or its bundle equivalent) and `env: { MY_VAR: "test-value" }`.
 */
export function testRuntime(label: string, getContext: () => RuntimeTestContext): void {
  describe(`runtime conformance: ${label}`, () => {
    // ── Tool execution ───────────────────────────────────────────────

    test("executes tool and returns result", async () => {
      const { executeTool } = getContext();
      const result = await executeTool("echo", { text: "hello" }, "s1", []);
      expect(result).toBe("echo:hello");
    });

    test("tool receives env variables", async () => {
      const { executeTool } = getContext();
      const result = await executeTool("get_env", {}, "s1", []);
      expect(result).toBe("test-value");
    });

    test("tool receives conversation messages", async () => {
      const { executeTool } = getContext();
      const msgs = [
        { role: "user" as const, content: "hi" },
        { role: "assistant" as const, content: "hello" },
      ];
      const result = await executeTool("echo_messages", {}, "s1", msgs);
      expect(JSON.parse(result)).toEqual(msgs);
    });

    test("KV round-trip through tool context", async () => {
      const { executeTool } = getContext();
      const result = await executeTool("kv_roundtrip", { value: "abc" }, "s1", []);
      expect(result).toBe('stored:"abc"');
    });

    // ── Session state ────────────────────────────────────────────────

    test("session state is initialized from factory", async () => {
      const { executeTool } = getContext();
      const result = await executeTool("get_state", {}, "state-init", []);
      const state = JSON.parse(result);
      expect(state).toHaveProperty("count", 0);
      expect(state).toHaveProperty("lastTurn", "");
    });

    test("onConnect hook updates session state", async () => {
      const { executeTool, hookInvoker } = getContext();
      const sid = "state-connect";
      await hookInvoker.onConnect(sid);
      const result = await executeTool("get_state", {}, sid, []);
      expect(JSON.parse(result).count).toBe(1);
    });

    test("onTurn hook updates session state", async () => {
      const { executeTool, hookInvoker } = getContext();
      const sid = "state-turn";
      await hookInvoker.onTurn(sid, "user said something");
      const result = await executeTool("get_state", {}, sid, []);
      expect(JSON.parse(result).lastTurn).toBe("user said something");
    });

    // ── Lifecycle hooks ──────────────────────────────────────────────

    test("onConnect resolves without error", async () => {
      const { hookInvoker } = getContext();
      await expect(hookInvoker.onConnect("hook-1")).resolves.toBeUndefined();
    });

    test("onDisconnect resolves without error", async () => {
      const { hookInvoker } = getContext();
      await expect(hookInvoker.onDisconnect("hook-2")).resolves.toBeUndefined();
    });

    test("onTurn resolves without error", async () => {
      const { hookInvoker } = getContext();
      await expect(hookInvoker.onTurn("hook-3", "test")).resolves.toBeUndefined();
    });

    test("onError resolves without error", async () => {
      const { hookInvoker } = getContext();
      await expect(hookInvoker.onError("hook-4", { message: "boom" })).resolves.toBeUndefined();
    });

    test("resolveTurnConfig returns null for static maxSteps", async () => {
      const { hookInvoker } = getContext();
      const config = await hookInvoker.resolveTurnConfig("hook-5");
      expect(config).toBeNull();
    });
  });
}
