// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for `Toolset` — the executor classification (the one place a
 * def's identity is read), gating, first-wins composition, and the dialog gate
 * layered over every toolset an agent carries.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentToolsToSchemas } from "./_internal-types.ts";
import { clientTool } from "./client-tool.ts";
import { tool } from "./define.ts";
import { dialog } from "./dialog.ts";
import { createToolContext } from "./testing.ts";
import {
  agentToolsets,
  composeToolsets,
  gateToolset,
  type ToolSource,
  toolEntry,
  toolset,
} from "./toolset.ts";
import { toolRefusal } from "./utils.ts";

const echo = tool({
  description: "Echo",
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }) => text,
});

describe("toolEntry", () => {
  it("classifies an ordinary def as host-executed", () => {
    expect(toolEntry(echo)).toEqual({ def: echo, executor: "host" });
  });

  it("classifies a clientTool as client-executed, carrying its deadline", () => {
    const where = clientTool({ description: "Where", timeoutMs: 20_000 });
    expect(toolEntry(where)).toEqual({ def: where, executor: "client", timeoutMs: 20_000 });
  });
});

describe("toolset", () => {
  it("lists, gates and executes over a map of defs", async () => {
    const set = toolset("files", { echo }, (name, _def, ctx) =>
      ctx.sessionId === "blocked" ? toolRefusal("dialog", `no ${name}`) : undefined,
    );
    expect(set.source).toBe("files");
    expect(Object.keys(set.list())).toEqual(["echo"]);
    expect(set.gate("echo", createToolContext())).toBeUndefined();
    expect(set.gate("echo", createToolContext({ sessionId: "blocked" }))).toEqual({
      error: "no echo",
      reason: "dialog",
    });
    expect(await set.execute("echo", { text: "hi" }, createToolContext())).toBe("hi");
  });

  it("names the missing tool rather than calling undefined", () => {
    expect(() => toolset("mcp", {}).execute("nope", {}, createToolContext())).toThrow(
      /mcp toolset has no tool "nope"/,
    );
  });
});

describe("composeToolsets", () => {
  it("is first-wins, and reports each shadowed name", () => {
    const other = tool({ description: "Other echo", execute: () => "other" });
    const shadowed: [string, ToolSource, ToolSource][] = [];
    const table = composeToolsets(
      [toolset("files", { echo }), toolset("builtin", { echo: other, think: other })],
      (name, kept, dropped) => shadowed.push([name, kept, dropped]),
    );
    expect(table.tools.map((one) => one.name)).toEqual(["echo", "think"]);
    expect(table.resolve("echo")?.entry.def).toBe(echo);
    expect(table.resolve("echo")?.toolset.source).toBe("files");
    expect(shadowed).toEqual([["echo", "files", "builtin"]]);
    // The advertised list is the same table: one schema per name.
    expect(
      agentToolsToSchemas([toolset("files", { echo }), toolset("builtin", { echo: other })]),
    ).toHaveLength(1);
  });
});

describe("gateToolset", () => {
  it("runs the set's own gate first, then each extra gate", () => {
    const own = toolset("roster", { echo }, () => toolRefusal("persona", "own"));
    const layered = gateToolset(own, [() => toolRefusal("dialog", "extra")]);
    expect(layered.gate("echo", createToolContext())?.reason).toBe("persona");
    const open = gateToolset(toolset("files", { echo }), [() => toolRefusal("dialog", "x")]);
    expect(open.gate("echo", createToolContext())?.reason).toBe("dialog");
  });
});

describe("agentToolsets", () => {
  const flow = dialog("flow", {
    initial: "start",
    states: {
      start: { instruction: "Verify first.", on: { GO: "open" } },
      open: { final: true },
    },
  });
  const gated = flow.tool({ ...echo, when: "open" });

  it("puts the files first, then the attached toolsets", () => {
    const extra = toolset("mcp", { mcp_x_y: echo });
    const sets = agentToolsets({ tools: { echo }, toolsets: [extra] });
    expect(sets.map((set) => set.source)).toEqual(["files", "mcp"]);
  });

  it("layers every dialog's gate, so a dialog tool refuses through `gate`", () => {
    const [files] = agentToolsets({ tools: { gated, echo }, dialogs: [flow] });
    const ctx = createToolContext();
    expect(files?.gate("gated", ctx)).toEqual({
      error: 'Not available yet: this conversation is at "start". Verify first.',
      reason: "dialog",
    });
    expect(files?.gate("echo", ctx)).toBeUndefined();
    flow.send(ctx, { type: "GO" });
    expect(files?.gate("gated", ctx)).toBeUndefined();
  });
});
