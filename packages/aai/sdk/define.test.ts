// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { agent, tool } from "./define.ts";

describe("tool()", () => {
  test("returns the definition unchanged", () => {
    const def = tool({
      description: "Greet someone",
      parameters: z.object({ name: z.string() }),
      execute: ({ name }) => `Hello, ${name}!`,
    });
    expect(def.description).toBe("Greet someone");
    expect(def.execute({ name: "Alice" }, {} as never)).toBe("Hello, Alice!");
  });

  test("works without parameters", () => {
    const def = tool({
      description: "No-param tool",
      execute: () => "done",
    });
    expect(def.description).toBe("No-param tool");
    expect(def.parameters).toBeUndefined();
  });
});

describe("agent()", () => {
  test("applies defaults", () => {
    const def = agent({ name: "Test Agent" });
    expect(def.name).toBe("Test Agent");
    expect(def.systemPrompt).toContain("You are AAI");
    expect(def.greeting).toContain("Hey there");
    expect(def.maxSteps).toBe(5);
    expect(def.tools).toEqual({});
  });

  test("preserves explicit values", () => {
    const greetTool = tool({
      description: "Greet",
      parameters: z.object({ name: z.string() }),
      execute: ({ name }) => `Hi ${name}`,
    });
    const def = agent({
      name: "Custom",
      systemPrompt: "Be nice.",
      greeting: "Hello!",
      maxSteps: 10,
      tools: { greet: greetTool },
      builtinTools: ["web_search"],
    });
    expect(def.systemPrompt).toBe("Be nice.");
    expect(def.greeting).toBe("Hello!");
    expect(def.maxSteps).toBe(10);
    expect(def.tools.greet).toBe(greetTool);
    expect(def.builtinTools).toEqual(["web_search"]);
  });
});
