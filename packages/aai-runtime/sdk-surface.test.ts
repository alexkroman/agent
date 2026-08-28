// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests for the SDK public API surface.
 *
 * These test the connected flow as a consumer would use it:
 * AgentDef → tools → direct executor → db in tool context.
 */

import type { AgentDef } from "@alexkroman1/aai";
import { sessionSlot } from "@alexkroman1/aai";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createRuntime } from "./runtime.ts";

describe("SDK integration: AgentDef → tool execution", () => {
  test("AgentDef + tools + executeToolCall round-trip", async () => {
    const agent: AgentDef = {
      name: "test-agent",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      tools: {
        greet: {
          description: "Greet by name",
          inputSchema: z.object({ name: z.string() }),
          execute: ({ name }: { name: string }) => `Hello, ${name}!`,
        },
      },
    };

    const exec = createRuntime({ agent, env: { ASSEMBLYAI_API_KEY: "test" } });
    const result = await exec.executeTool("greet", { name: "Alice" }, "s1", []);
    expect(result).toBe("Hello, Alice!");
  });

  // A "tool with db access works end-to-end" test stood here, injecting a fake
  // `Db` the way the platform injected an app's real Postgres. `ctx.db` is gone:
  // the platform provisions no database and no longer hands one to tool code, so
  // an author who wants SQL brings their own client and credential. Nothing
  // replaces it here — a tool calling somebody else's library is not this
  // package's surface to integration-test.
  test("env vars are passed to tool context", async () => {
    const agent: AgentDef = {
      name: "env-agent",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      tools: {
        check_key: {
          description: "Check API key",
          execute: (_args, ctx) => ctx.env.API_KEY ?? "missing",
        },
      },
    };

    const exec = createRuntime({
      agent,
      env: { API_KEY: "sk-test-123", ASSEMBLYAI_API_KEY: "test" },
    });
    const result = await exec.executeTool("check_key", {}, "s1", []);
    expect(result).toBe("sk-test-123");
  });

  test("per-session state isolation", async () => {
    const countSlot = sessionSlot("count", () => ({ count: 0 }));
    const agent: AgentDef = {
      name: "state-agent",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      tools: {
        increment: {
          description: "Increment counter",
          execute: (_args, ctx) => String(countSlot.update(ctx, (state) => ++state.count)),
        },
      },
    };

    const exec = createRuntime({ agent, env: { ASSEMBLYAI_API_KEY: "test" } });
    expect(await exec.executeTool("increment", {}, "session-a", [])).toBe("1");
    expect(await exec.executeTool("increment", {}, "session-a", [])).toBe("2");
    expect(await exec.executeTool("increment", {}, "session-b", [])).toBe("1");
  });

  test("unknown tool returns error JSON", async () => {
    const agent: AgentDef = {
      name: "test",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      tools: {},
    };
    const exec = createRuntime({ agent, env: { ASSEMBLYAI_API_KEY: "test" } });
    const result = await exec.executeTool("nonexistent", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({ error: "Unknown tool: nonexistent" });
  });

  test("tool parameter validation rejects bad input", async () => {
    const agent: AgentDef = {
      name: "validation-agent",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      tools: {
        typed: {
          description: "Typed tool",
          inputSchema: z.object({ count: z.number() }),
          execute: ({ count }: { count: number }) => String(count * 2),
        },
      },
    };

    const exec = createRuntime({ agent, env: { ASSEMBLYAI_API_KEY: "test" } });
    expect(await exec.executeTool("typed", { count: 5 }, "s1", [])).toBe("10");
    const err = await exec.executeTool("typed", { count: "not a number" }, "s1", []);
    expect(err).toContain("error");
  });

  test("toAgentConfig produces serializable config", () => {
    const agent: AgentDef = {
      name: "config-test",
      systemPrompt: "Custom instructions",
      greeting: "Hello!",
      maxSteps: 10,
      tools: {},
      builtinTools: ["web_search"],
      toolChoice: "required",
    };

    const config = toAgentConfig(agent);
    const parsed = JSON.parse(JSON.stringify(config));
    expect(parsed.name).toBe("config-test");
    expect(parsed.systemPrompt).toBe("Custom instructions");
    expect(parsed.builtinTools).toEqual(["web_search"]);
    expect(parsed.maxSteps).toBe(10);
    expect(parsed.toolChoice).toBe("required");
  });

  test("builtin tools are available alongside custom tools", async () => {
    const agent: AgentDef = {
      name: "mixed-tools",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      builtinTools: ["run_code"],
      tools: {
        custom: { description: "Custom tool", execute: () => "custom result" },
      },
    };

    const exec = createRuntime({ agent, env: { ASSEMBLYAI_API_KEY: "test" } });
    expect(await exec.executeTool("custom", {}, "s1", [])).toBe("custom result");
    // run_code is registered as a builtin, but in the self-hosted path (no
    // sandbox) it must NOT execute on the host — it only runs inside the guest
    // sandbox. Invoking it here returns the guard error, not code output.
    const codeResult = await exec.executeTool(
      "run_code",
      { code: 'console.log("from builtin")' },
      "s1",
      [],
    );
    expect(codeResult).toContain("only available in the sandboxed runtime");
    const names = exec.toolSchemas.map((s) => s.name);
    expect(names).toContain("custom");
    expect(names).toContain("run_code");
  });

  test("messages are passed through to tool context", async () => {
    const agent: AgentDef = {
      name: "messages-agent",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      tools: {
        count_msgs: {
          description: "Count messages",
          execute: (_args, ctx) => String(ctx.messages.length),
        },
      },
    };

    const exec = createRuntime({ agent, env: { ASSEMBLYAI_API_KEY: "test" } });
    const result = await exec.executeTool("count_msgs", {}, "s1", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(result).toBe("2");
  });
});
