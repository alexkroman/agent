// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { buildAgentConfig, createDirectExecutor } from "./direct_executor.ts";
import type { AgentDef } from "./types.ts";

function makeAgent(overrides?: Partial<AgentDef>): AgentDef {
  return {
    name: "test-agent",
    instructions: "Be helpful.",
    greeting: "Hello!",
    maxSteps: 5,
    tools: {},
    ...overrides,
  };
}

describe("buildAgentConfig", () => {
  test("maps name, instructions, greeting from AgentDef", () => {
    const config = buildAgentConfig(makeAgent());
    expect(config.name).toBe("test-agent");
    expect(config.instructions).toBe("Be helpful.");
    expect(config.greeting).toBe("Hello!");
  });

  test("includes sttPrompt when defined", () => {
    const config = buildAgentConfig(makeAgent({ sttPrompt: "transcription hint" }));
    expect(config.sttPrompt).toBe("transcription hint");
  });

  test("omits sttPrompt when undefined", () => {
    const config = buildAgentConfig(makeAgent());
    expect(config).not.toHaveProperty("sttPrompt");
  });

  test("includes static maxSteps", () => {
    const config = buildAgentConfig(makeAgent({ maxSteps: 10 }));
    expect(config.maxSteps).toBe(10);
  });

  test("excludes function maxSteps", () => {
    const config = buildAgentConfig(makeAgent({ maxSteps: () => 10 }));
    expect(config).not.toHaveProperty("maxSteps");
  });

  test("includes toolChoice when defined", () => {
    const config = buildAgentConfig(makeAgent({ toolChoice: "required" }));
    expect(config.toolChoice).toBe("required");
  });

  test("omits toolChoice when undefined", () => {
    const config = buildAgentConfig(makeAgent());
    expect(config).not.toHaveProperty("toolChoice");
  });

  test("includes builtinTools when defined", () => {
    const config = buildAgentConfig(makeAgent({ builtinTools: ["web_search", "run_code"] }));
    expect(config.builtinTools).toEqual(["web_search", "run_code"]);
  });

  test("includes activeTools when defined", () => {
    const config = buildAgentConfig(makeAgent({ activeTools: ["toolA", "toolB"] }));
    expect(config.activeTools).toEqual(["toolA", "toolB"]);
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
});
