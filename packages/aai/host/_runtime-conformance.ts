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

import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { ExecuteTool } from "../sdk/_internal-types.ts";
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
    echo: {
      description: "Echo input",
      inputSchema: z.object({ text: z.string() }),
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
  },
};

/**
 * Run the runtime conformance test suite against a given runtime context.
 *
 * `getContext` is invoked once per test so callers can lazily set up the
 * runtime in a `beforeAll`. All tests assume the runtime was created with
 * {@link CONFORMANCE_AGENT} and `env: { MY_VAR: "test-value" }`.
 */
export function testRuntime(label: string, getContext: () => RuntimeTestContext): void {
  describe(`runtime conformance: ${label}`, () => {
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

    test("session state is initialized from factory", async () => {
      const { executeTool } = getContext();
      const result = await executeTool("get_state", {}, "state-init", []);
      const state = JSON.parse(result);
      expect(state).toHaveProperty("count", 0);
      expect(state).toHaveProperty("lastTurn", "");
    });
  });
}
