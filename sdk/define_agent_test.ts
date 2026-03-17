// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineAgent } from "./define_agent.ts";
import { DEFAULT_GREETING, DEFAULT_INSTRUCTIONS } from "./types.ts";

describe("defineAgent", () => {
  test("applies defaults", () => {
    const agent = defineAgent({ name: "Test" });
    expect(agent.name).toBe("Test");
    expect(agent.voice).toBe("");
    expect(agent.instructions).toBe(DEFAULT_INSTRUCTIONS);
    expect(agent.greeting).toBe(DEFAULT_GREETING);
    expect(agent.transport).toEqual(["websocket"]);
    expect(agent.env).toEqual(["ASSEMBLYAI_API_KEY"]);
    expect(agent.tools).toEqual({});
  });

  test("preserves custom values", () => {
    const agent = defineAgent({
      name: "Custom",
      voice: "a167e0f3-df7e-4d52-a9c3-f949145efdab",
      instructions: "Be a pirate",
      greeting: "Ahoy",
      transport: "websocket",
      env: ["MY_KEY"],
    });
    expect(agent.voice).toBe("a167e0f3-df7e-4d52-a9c3-f949145efdab");
    expect(agent.instructions).toBe("Be a pirate");
    expect(agent.greeting).toBe("Ahoy");
    expect(agent.transport).toEqual(["websocket"]);
    expect(agent.env).toEqual(["MY_KEY"]);
  });

  test("normalizes transport array", () => {
    const agent = defineAgent({
      name: "Multi",
      transport: ["websocket"],
    });
    expect(agent.transport).toEqual(["websocket"]);
  });

  test("preserves tools", () => {
    const tools = {
      greet: {
        description: "Say hello",
        parameters: z.object({ name: z.string() }),
        execute: ({ name }: Record<string, unknown>) => `Hello ${name}`,
      },
    };
    const agent = defineAgent({ name: "Test", tools });
    expect(Object.keys(agent.tools)).toEqual(["greet"]);
    expect(agent.tools.greet!.description).toBe("Say hello");
  });

  test("preserves lifecycle hooks", () => {
    const onConnect = () => {};
    const onDisconnect = () => {};
    const onError = () => {};
    const onTurn = () => {};
    const agent = defineAgent({
      name: "Test",
      onConnect,
      onDisconnect,
      onError,
      onTurn,
    });
    expect(agent.onConnect).toBe(onConnect);
    expect(agent.onDisconnect).toBe(onDisconnect);
    expect(agent.onError).toBe(onError);
    expect(agent.onTurn).toBe(onTurn);
  });

  test("preserves sttPrompt, maxSteps, and builtinTools", () => {
    const agent = defineAgent({
      name: "Test",
      sttPrompt: "Transcribe accurately",
      maxSteps: 10,
      builtinTools: ["web_search", "run_code"],
    });
    expect(agent.sttPrompt).toBe("Transcribe accurately");
    expect(agent.maxSteps).toBe(10);
    expect(agent.builtinTools).toEqual(["web_search", "run_code"]);
  });

  test("maxSteps defaults to 5", () => {
    const agent = defineAgent({ name: "Test" });
    expect(agent.maxSteps).toBe(5);
  });
});
