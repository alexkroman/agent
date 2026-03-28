// Copyright 2025 the AAI authors. MIT license.

import { createStorage } from "unstorage";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { toAgentConfig } from "./_internal-types.ts";
import { makeAgent } from "./_test-utils.ts";
import { createDirectExecutor } from "./direct-executor.ts";
import { defineTool } from "./types.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";

describe("toAgentConfig", () => {
  test("maps name, instructions, greeting from AgentDef", () => {
    const config = toAgentConfig(makeAgent());
    expect(config.name).toBe("test-agent");
    expect(config.instructions).toBe("Be helpful.");
    expect(config.greeting).toBe("Hello!");
  });

  test("includes sttPrompt when defined", () => {
    const config = toAgentConfig(makeAgent({ sttPrompt: "transcription hint" }));
    expect(config.sttPrompt).toBe("transcription hint");
  });

  test("omits sttPrompt when undefined", () => {
    const config = toAgentConfig(makeAgent());
    expect(config).not.toHaveProperty("sttPrompt");
  });

  test("includes static maxSteps", () => {
    const config = toAgentConfig(makeAgent({ maxSteps: 10 }));
    expect(config.maxSteps).toBe(10);
  });

  test("excludes function maxSteps", () => {
    const config = toAgentConfig(makeAgent({ maxSteps: () => 10 }));
    expect(config).not.toHaveProperty("maxSteps");
  });

  test("includes toolChoice when defined", () => {
    const config = toAgentConfig(makeAgent({ toolChoice: "required" }));
    expect(config.toolChoice).toBe("required");
  });

  test("omits toolChoice when undefined", () => {
    const config = toAgentConfig(makeAgent());
    expect(config).not.toHaveProperty("toolChoice");
  });

  test("includes builtinTools when defined", () => {
    const config = toAgentConfig(makeAgent({ builtinTools: ["web_search", "run_code"] }));
    expect(config.builtinTools).toEqual(["web_search", "run_code"]);
  });
});

describe("createDirectExecutor", () => {
  test("executeTool returns error for unknown tool", async () => {
    const exec = createDirectExecutor({ agent: makeAgent(), env: {} });
    const result = await exec.executeTool("nonexistent", {}, "session-1", []);
    expect(result).toBe(JSON.stringify({ error: "Unknown tool: nonexistent" }));
  });

  test("hookInvoker.onConnect can be called without error", async () => {
    const exec = createDirectExecutor({ agent: makeAgent(), env: {} });
    await expect(exec.hookInvoker.onConnect("session-1")).resolves.toBeUndefined();
  });

  test("executeTool with a real tool returns result", async () => {
    const agent = makeAgent({
      tools: {
        add: defineTool({
          description: "Add two numbers",
          parameters: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => String(a + b),
        }),
      },
    });
    const exec = createDirectExecutor({ agent, env: {} });
    expect(await exec.executeTool("add", { a: 3, b: 4 }, "s1", [])).toBe("7");
  });

  test("executeTool passes KV to tool context", async () => {
    const kv = createUnstorageKv({ storage: createStorage() });
    await kv.set("key1", "value1");
    const agent = makeAgent({
      tools: {
        read_kv: {
          description: "Read from KV",
          execute: async (_args, ctx) => (await ctx.kv.get<string>("key1")) ?? "missing",
        },
      },
    });
    const exec = createDirectExecutor({ agent, env: {}, kv });
    expect(await exec.executeTool("read_kv", {}, "s1", [])).toBe("value1");
  });

  test("toolSchemas includes both custom and builtin tools", () => {
    const agent = makeAgent({
      builtinTools: ["run_code"],
      tools: {
        custom: { description: "Custom", execute: () => "ok" },
      },
    });
    const exec = createDirectExecutor({ agent, env: {} });
    const names = exec.toolSchemas.map((s) => s.name);
    expect(names).toContain("custom");
    expect(names).toContain("run_code");
  });

  test("resolveTurnConfig returns null when no dynamic config", async () => {
    const exec = createDirectExecutor({ agent: makeAgent(), env: {} });
    expect(await exec.hookInvoker.resolveTurnConfig("s1")).toBe(null);
  });

  test("resolveTurnConfig resolves dynamic maxSteps", async () => {
    const agent = makeAgent({ maxSteps: () => 15 });
    const exec = createDirectExecutor({ agent, env: {} });
    const config = await exec.hookInvoker.resolveTurnConfig("s1");
    expect(config?.maxSteps).toBe(15);
  });

  test("hookInvoker.onDisconnect calls agent.onDisconnect", async () => {
    const onDisconnect = vi.fn();
    const agent = makeAgent({ onDisconnect });
    const exec = createDirectExecutor({ agent, env: {} });
    await exec.hookInvoker.onDisconnect("session-1");
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  test("hookInvoker.onTurn calls agent.onTurn with text", async () => {
    const onTurn = vi.fn();
    const agent = makeAgent({ onTurn });
    const exec = createDirectExecutor({ agent, env: {} });
    await exec.hookInvoker.onTurn("s1", "hello world");
    expect(onTurn).toHaveBeenCalledWith("hello world", expect.any(Object));
  });

  test("hookInvoker.onError calls agent.onError with Error", async () => {
    const onError = vi.fn();
    const agent = makeAgent({ onError });
    const exec = createDirectExecutor({ agent, env: {} });
    await exec.hookInvoker.onError("s1", { message: "boom" });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
    const err = onError.mock.calls[0]?.[0] as Error;
    expect(err.message).toBe("boom");
  });

  test("session state is initialized from agent.state factory", async () => {
    const agent = makeAgent({
      state: () => ({ counter: 0 }),
      tools: {
        get_state: {
          description: "Get state",
          execute: (_args, ctx) => JSON.stringify(ctx.state),
        },
      },
    });
    const exec = createDirectExecutor({ agent, env: {} });
    const result = await exec.executeTool("get_state", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({ counter: 0 });
  });

  test("executeTool passes messages to tool context", async () => {
    const agent = makeAgent({
      tools: {
        echo_messages: {
          description: "Echo messages",
          execute: (_args, ctx) => JSON.stringify(ctx.messages),
        },
      },
    });
    const exec = createDirectExecutor({ agent, env: {} });
    const msgs = [{ role: "user" as const, content: "hi" }];
    const result = await exec.executeTool("echo_messages", {}, "s1", msgs);
    expect(JSON.parse(result)).toEqual(msgs);
  });

  test("ctx.fetch is available in tool context", async () => {
    const agent = makeAgent({
      tools: {
        check_fetch: {
          description: "Check fetch exists",
          execute: (_args, ctx) => typeof ctx.fetch,
        },
      },
    });
    const exec = createDirectExecutor({ agent, env: {} });
    const result = await exec.executeTool("check_fetch", {}, "s1", []);
    expect(result).toBe("function");
  });

  test("ctx.fetch blocks private IPs (SSRF protection)", async () => {
    const agent = makeAgent({
      tools: {
        fetch_private: {
          description: "Attempt to fetch a private IP",
          execute: async (_args, ctx) => {
            try {
              await ctx.fetch("http://169.254.169.254/latest/meta-data/");
              return "should not reach here";
            } catch (err) {
              return (err as Error).message;
            }
          },
        },
      },
    });
    const exec = createDirectExecutor({ agent, env: {} });
    const result = await exec.executeTool("fetch_private", {}, "s1", []);
    expect(result).toContain("private address");
  });

  test("hook context includes fetch", async () => {
    let hookFetch: unknown;
    const agent = makeAgent({
      onConnect: (ctx) => {
        hookFetch = ctx.fetch;
      },
    });
    const exec = createDirectExecutor({ agent, env: {} });
    await exec.hookInvoker.onConnect("s1");
    expect(typeof hookFetch).toBe("function");
  });

  test("env is frozen and passed to tools", async () => {
    const agent = makeAgent({
      tools: {
        get_env: {
          description: "Get env",
          execute: (_args, ctx) => ctx.env.MY_VAR ?? "missing",
        },
      },
    });
    const exec = createDirectExecutor({ agent, env: { MY_VAR: "hello" } });
    const result = await exec.executeTool("get_env", {}, "s1", []);
    expect(result).toBe("hello");
  });
});
