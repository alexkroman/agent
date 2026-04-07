// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { DEFAULT_GREETING, DEFAULT_INSTRUCTIONS, defineAgent } from "./types.ts";

describe("defineAgent", () => {
  test("applies defaults", () => {
    const agent = defineAgent({ name: "Test" });
    expect(agent.name).toBe("Test");
    expect(agent.instructions).toBe(DEFAULT_INSTRUCTIONS);
    expect(agent.greeting).toBe(DEFAULT_GREETING);
    expect(agent.tools).toEqual({});
  });

  test("preserves custom values", () => {
    const agent = defineAgent({
      name: "Custom",
      instructions: "Be a pirate",
      greeting: "Ahoy",
    });
    expect(agent.instructions).toBe("Be a pirate");
    expect(agent.greeting).toBe("Ahoy");
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
    expect(agent.tools.greet?.description).toBe("Say hello");
  });

  test("preserves lifecycle hooks", () => {
    const onConnect = () => {
      /* noop */
    };
    const onDisconnect = () => {
      /* noop */
    };
    const onTurn = () => {
      /* noop */
    };
    const agent = defineAgent({
      name: "Test",
      onConnect,
      onDisconnect,
      onTurn,
    });
    expect(agent.onConnect).toBe(onConnect);
    expect(agent.onDisconnect).toBe(onDisconnect);
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
