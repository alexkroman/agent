// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { CreateProjectSchema, projectBaseFromPrompt } from "./studio-schemas.ts";

describe("projectBaseFromPrompt", () => {
  test.each([
    // Filler ("build me a", "agent", "voice") drops; the subject stays.
    ["Build me a contact form agent", "contact-form"],
    ["I want a voice agent that takes pizza orders", "takes-pizza-orders"],
    ["Café ordering", "cafe-ordering"],
    // Nothing but filler → empty; the generator falls back to words.
    ["build me an agent", ""],
    ["", ""],
    ["!!!", ""],
  ])("%j → %j", (prompt, base) => {
    expect(projectBaseFromPrompt(prompt)).toBe(base);
  });

  test("caps the base length for very long prompts", () => {
    const base = projectBaseFromPrompt(
      "supercalifragilistic expialidocious telemarketing dashboard reporting system",
    );
    expect(base.length).toBeLessThanOrEqual(30);
    expect(base.length).toBeGreaterThan(0);
  });
});

describe("CreateProjectSchema", () => {
  test("accepts prompt-only, name-only, and empty bodies", () => {
    expect(CreateProjectSchema.safeParse({ prompt: "hi there" }).success).toBe(true);
    expect(CreateProjectSchema.safeParse({ name: "My Agent" }).success).toBe(true);
    expect(CreateProjectSchema.safeParse({}).success).toBe(true);
  });

  test("still slugifies and validates an explicit name", () => {
    const parsed = CreateProjectSchema.parse({ name: "My Agent" });
    expect(parsed.name).toBe("my-agent");
    expect(CreateProjectSchema.safeParse({ name: "!!!" }).success).toBe(false);
    expect(CreateProjectSchema.safeParse({ name: "studio" }).success).toBe(false);
  });
});
