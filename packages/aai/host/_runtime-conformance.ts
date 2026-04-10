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
 *   const exec = createRuntime({ agent: CONFORMANCE_AGENT, env: { MY_VAR: "test-value" } });
 *   return { executeTool: exec.executeTool, hooks: exec.hooks };
 * });
 * ```
 *
 * @example Sandbox (integration test in aai-server)
 * ```ts
 * import { testRuntime } from "aai/host";
 *
 * testRuntime("sandbox", async () => {
 *   // ... start isolate with a bundled agent
 *   return { executeTool: buildExecuteTool(...), hooks: buildHookInvoker(...) };
 * });
 * ```
 */

import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { ExecuteTool } from "../sdk/_internal-types.ts";
import type { AgentDef } from "../sdk/types.ts";

// ── Shared context type ────────────────────────────────────────────────────

/**
 * Minimal runtime surface needed for conformance tests.
 *
 * Both `Runtime` and `buildExecuteTool`/`buildHookInvoker` from the
 * sandbox produce objects that satisfy this interface.
 */
export type RuntimeTestContext = {
  executeTool: ExecuteTool;
};

// ── Conformance agent ──────────────────────────────────────────────────────

/** Agent definition used by the conformance suite (direct executor path). */
export const CONFORMANCE_AGENT: AgentDef = {
  name: "conformance-test",
  systemPrompt: "Conformance test agent.",
  greeting: "Hello!",
  maxSteps: 5,
  state: () => ({ count: 0, lastTurn: "" }),
  tools: {
    echo: {
      description: "Echo input",
      parameters: z.object({ text: z.string() }),
      execute: ({ text }: { text: string }) => `echo:${text}`,
    },
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
    kv_roundtrip: {
      description: "KV set then get",
      parameters: z.object({ value: z.string() }),
      execute: async ({ value }: { value: string }, ctx) => {
        await ctx.kv.set("test-key", value);
        const result = await ctx.kv.get<string>("test-key");
        return `stored:${JSON.stringify(result)}`;
      },
    },
  },
};

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
  });
}
