// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared runtime conformance tests.
 *
 * Both the self-hosted direct executor and the platform sandbox must satisfy
 * the same behavioral contract. This module defines that contract as a
 * reusable test suite that can be wired to either runtime.
 *
 * Inspired by Nitro's `testNitro()` pattern: one test fixture, many runtimes.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { ExecuteTool } from "../sdk/_internal-types.ts";
import { tool } from "../sdk/define.ts";
import type { AgentDef } from "../sdk/types.ts";

export type RuntimeTestContext = {
  executeTool: ExecuteTool;
};

export const CONFORMANCE_AGENT: AgentDef = {
  name: "conformance-test",
  systemPrompt: "Conformance test agent.",
  greeting: "Hello!",
  maxSteps: 5,
  state: () => ({ count: 0, lastTurn: "" }),
  tools: {
    echo: tool({
      description: "Echo input",
      parameters: z.object({ text: z.string() }),
      execute: ({ text }) => `echo:${text}`,
    }),
    get_env: tool({
      description: "Get MY_VAR from env",
      execute: (_args, ctx) => ctx.env.MY_VAR ?? "missing",
    }),
    get_state: tool({
      description: "Get session state",
      execute: (_args, ctx) => JSON.stringify(ctx.state),
    }),
    echo_messages: tool({
      description: "Return messages as JSON",
      execute: (_args, ctx) => JSON.stringify(ctx.messages),
    }),
    kv_roundtrip: tool({
      description: "KV set then get",
      parameters: z.object({ value: z.string() }),
      execute: async ({ value }, ctx) => {
        await ctx.kv.set("test-key", value);
        const result = await ctx.kv.get<string>("test-key");
        return `stored:${JSON.stringify(result)}`;
      },
    }),
    vector_roundtrip: tool({
      description: "Test Vector roundtrip via tool execution",
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }, ctx) => {
        await ctx.vector.upsert("conformance-doc", text);
        const matches = await ctx.vector.query(text, { topK: 1 });
        await ctx.vector.delete("conformance-doc");
        return matches[0]?.text ?? "(none)";
      },
    }),
  },
};

/**
 * Run the runtime conformance test suite against a given runtime context.
 *
 * `getContext` is invoked once per test so callers can lazily set up the
 * runtime in a `beforeAll`. All tests assume the runtime was created with
 * {@link CONFORMANCE_AGENT} and `env: { MY_VAR: "test-value" }`.
 */
const SESSION_ID = "s1";

export function testRuntime(label: string, getContext: () => RuntimeTestContext): void {
  describe(`runtime conformance: ${label}`, () => {
    let executeTool: ExecuteTool;
    beforeEach(() => {
      executeTool = getContext().executeTool;
    });

    test("executes tool and returns result", async () => {
      const result = await executeTool("echo", { text: "hello" }, SESSION_ID, []);
      expect(result).toBe("echo:hello");
    });

    test("tool receives env variables", async () => {
      const result = await executeTool("get_env", {}, SESSION_ID, []);
      expect(result).toBe("test-value");
    });

    test("tool receives conversation messages", async () => {
      const msgs = [
        { role: "user" as const, content: "hi" },
        { role: "assistant" as const, content: "hello" },
      ];
      const result = await executeTool("echo_messages", {}, SESSION_ID, msgs);
      expect(JSON.parse(result)).toEqual(msgs);
    });

    test("KV round-trip through tool context", async () => {
      const result = await executeTool("kv_roundtrip", { value: "abc" }, SESSION_ID, []);
      expect(result).toBe('stored:"abc"');
    });

    test("Vector round-trip through tool context", async () => {
      const vectorResult = await executeTool(
        "vector_roundtrip",
        { text: "conformance-input" },
        SESSION_ID,
        [],
      );
      expect(vectorResult).toBe("conformance-input");
    });

    test("session state is initialized from factory", async () => {
      const result = await executeTool("get_state", {}, "state-init", []);
      const state = JSON.parse(result);
      expect(state).toMatchObject({ count: 0, lastTurn: "" });
    });
  });
}
