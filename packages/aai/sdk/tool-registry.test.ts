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
import { toolRegistry, withTools } from "./tool-registry.ts";

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

  test("refuses a barrel, which would register a tool named index", () => {
    // The directory IS the registry, so there is nothing for an index to
    // re-export — and registered rather than refused, it put whatever the
    // barrel default-exported in front of the model under the name `index`.
    expect(() => toolRegistry({ "./tools/index.ts": { default: echo } })).toThrow(
      /is a barrel, and a tools\/ file IS a tool/,
    );
  });

  test("refuses a name past the provider cap, which fails at the first turn otherwise", () => {
    const long = `t${"o".repeat(64)}`;
    expect(() => toolRegistry({ [`./tools/${long}.ts`]: { default: echo } })).toThrow(
      /65 characters, and a provider caps a tool name at 64/,
    );
  });

  test("accepts a name exactly at the cap", () => {
    const name = `t${"o".repeat(63)}`;
    expect(Object.keys(toolRegistry({ [`./tools/${name}.ts`]: { default: echo } }))).toEqual([
      name,
    ]);
  });

  test("points a helper module out of tools/ rather than only naming the export", () => {
    // Every file in tools/ is a tool, so "add a default export" is the wrong
    // remedy for the file that is not one.
    expect(() => toolRegistry({ "./tools/helpers.ts": { shared: 1 } })).toThrow(
      /a helper this directory shares belongs beside it rather than in it/,
    );
  });

  test("an empty set of modules is an empty registry, not an error", () => {
    // A project with no tools/ directory is legal — a workflow app has none.
    expect(toolRegistry({})).toEqual({});
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
