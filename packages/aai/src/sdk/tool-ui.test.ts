// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { ToolSchemaSchema } from "./tool-schema.ts";
import { normalizeToolUi, toolUiMap } from "./tool-ui.ts";
import { toolset } from "./toolset.ts";
import type { ToolDef } from "./types.ts";

const noop = async () => "ok";

describe("toolUiMap", () => {
  test("keys each declared hint by tool name, first toolset winning, and is undefined with none", () => {
    const files: Record<string, ToolDef> = {
      add_pizza: { description: "Add", execute: noop, ui: { icon: "🍕", label: "Adding pizza" } },
      plain: { description: "Plain", execute: noop },
    };
    const builtins: Record<string, ToolDef> = {
      // Shadowed by the file of the same name: its hint is not advertised,
      // because its tool is not the one that runs.
      add_pizza: { description: "Builtin", execute: noop, ui: { label: "Shadowed" } },
      web_search: { description: "Search", execute: noop, ui: { icon: "🔎" } },
    };
    expect(toolUiMap({ tools: files, toolsets: [toolset("builtin", builtins)] })).toEqual({
      add_pizza: { icon: "🍕", label: "Adding pizza" },
      web_search: { icon: "🔎" },
    });
    expect(toolUiMap({ tools: { plain: files.plain as ToolDef } })).toBeUndefined();
  });

  test("what it builds is what the wire schema accepts", () => {
    const ui = normalizeToolUi({ icon: "🔎", label: undefined });
    expect(ui).toEqual({ icon: "🔎" });
    expect(
      ToolSchemaSchema.safeParse({
        type: "function",
        name: "web_search",
        description: "Search",
        parameters: {},
        ui,
      }).success,
    ).toBe(true);
  });
});
