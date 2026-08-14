// Copyright 2026 the AAI authors. MIT license.
/**
 * The registry's diagnostics ARE its feature, so they are what this pins.
 *
 * Discovery replaces a hand-written `tools:` map, and the whole argument for
 * doing so is that a mistake stops being silent. A registry that accepted a
 * misnamed file, a file exporting the wrong thing, or two files claiming one
 * name would put the silence back one layer down — so each of those is asserted
 * to throw, and to NAME the file, because the message is the only thing an
 * author sees.
 */

import { describe, expect, test } from "vitest";
import { agent, tool } from "./define.ts";
import { loadToolModules, toolRegistry, withTools } from "./tool-registry.ts";

const echo = tool({ description: "Echo the input.", execute: (args) => args });
const other = tool({ description: "Something else.", execute: () => null });

/** A module namespace as a bundler or a glob hands it over. */
const mod = (value: unknown) => ({ default: value });

describe("toolRegistry", () => {
  test.each([
    ["a glob key", "./tools/incident_create.ts"],
    ["a generated-entry key", "tools/incident_create.ts"],
    ["an absolute path", "/workspace/agent/tools/incident_create.ts"],
    ["a .tsx file", "./tools/incident_create.tsx"],
    ["a built .mjs file", "./tools/incident_create.mjs"],
  ])("names the tool from its file name, given %s", (_label, path) => {
    expect(toolRegistry({ [path]: mod(echo) })).toEqual({ incident_create: echo });
  });

  test("carries the tool through by identity, not a copy", () => {
    // The runtime calls `execute` off this object, and a spec compares against
    // the module's own export — a clone would break both.
    expect(toolRegistry({ "tools/echo.ts": mod(echo) }).echo).toBe(echo);
  });

  test("skips a co-located spec rather than registering `foo.test`", () => {
    const registry = toolRegistry({
      "tools/echo.ts": mod(echo),
      "tools/echo.test.ts": mod({ not: "a tool" }),
      "tools/echo.spec.ts": mod({ not: "a tool" }),
    });
    expect(Object.keys(registry)).toEqual(["echo"]);
  });

  test("rejects a nested file, naming it and the flat path to use", () => {
    expect(() => toolRegistry({ "tools/billing/refund.ts": mod(echo) })).toThrow(
      /tools\/billing\/refund\.ts is nested.*tools\/refund\.ts/s,
    );
  });

  test.each([
    ["kebab-case", "tools/incident-create.ts"],
    ["a leading capital", "tools/IncidentCreate.ts"],
    ["a leading digit", "tools/2fa_check.ts"],
  ])("rejects %s as a tool name", (_label, path) => {
    expect(() => toolRegistry({ [path]: mod(echo) })).toThrow(/not a usable tool name/);
  });

  test("rejects a file with no default export", () => {
    expect(() => toolRegistry({ "tools/echo.ts": { echo } })).toThrow(
      /tools\/echo\.ts has no default export/,
    );
  });

  test.each([
    ["a plain object", { description: "no execute" }],
    ["a bare function", () => null],
    ["a string", "nope"],
    ["null", null],
  ])("rejects a default export that is %s", (_label, value) => {
    expect(() => toolRegistry({ "tools/echo.ts": mod(value) })).toThrow(
      /does not default-export a tool/,
    );
  });

  test("rejects two files claiming one name, naming both", () => {
    expect(() =>
      toolRegistry({ "tools/echo.ts": mod(echo), "other/tools/echo.mts": mod(other) }),
    ).toThrow(/Two files declare the tool "echo": tools\/echo\.ts and other\/tools\/echo\.mts/);
  });

  test("an empty set of modules is an empty registry, not an error", () => {
    // A project with no tools/ directory is legal — a workflow app has none.
    expect(toolRegistry({})).toEqual({});
  });
});

describe("loadToolModules", () => {
  test("awaits each loader and applies the same rules", async () => {
    const registry = await loadToolModules({
      "./tools/echo.ts": () => Promise.resolve(mod(echo)),
      "./tools/other.ts": () => Promise.resolve(mod(other)),
    });
    expect(registry).toEqual({ echo, other: other });
  });

  test("propagates a diagnostic from a loaded module", async () => {
    await expect(
      loadToolModules({ "./tools/echo.ts": () => Promise.resolve(mod("nope")) }),
    ).rejects.toThrow(/does not default-export a tool/);
  });
});

describe("withTools", () => {
  test("returns a def carrying the registry", () => {
    const def = withTools(agent({ name: "a" }), { echo });
    expect(def.tools).toEqual({ echo });
  });

  test("does not mutate the def it was handed", () => {
    // The def a module default-exports is shared, so a loader that rewrote it
    // would make import order decide what the agent can do.
    const base = agent({ name: "a" });
    withTools(base, { echo });
    expect(base.tools).toEqual({});
  });

  test("refuses a name the def already declares, rather than shadowing it", () => {
    const base = { ...agent({ name: "a" }), tools: { echo: other } };
    expect(() => withTools(base, { echo })).toThrow(/The tool "echo" is declared twice/);
  });

  test("leaves every other field of the def alone", () => {
    const base = agent({ name: "a", greeting: "hi" });
    expect(withTools(base, { echo })).toMatchObject({ name: "a", greeting: "hi" });
  });
});
