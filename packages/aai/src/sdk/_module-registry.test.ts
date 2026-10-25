// Copyright 2026 the AAI authors. MIT license.
/**
 * The one rule for what is a `tools/` or `workflows/` MODULE, shared by the
 * two registries and the vitest plugin's directory scan.
 */
import { describe, expect, test } from "vitest";
import { isWorkflowDef, MODULE_EXT_RE, moduleNameOf, SPEC_RE } from "./_module-registry.ts";

describe("SPEC_RE", () => {
  test.each([
    "echo.test",
    "echo.spec",
    "echo.test-d",
    "echo.integration.test",
    "echo.scenario.test",
    "echo.eval.test",
  ])(
    "%s is a spec, whatever tier it is in — the union of every reader's former spelling",
    (name) => {
      expect(SPEC_RE.test(name)).toBe(true);
    },
  );

  test.each(["echo", "test", "spec_runner", "latest"])("%s is a module", (name) => {
    expect(SPEC_RE.test(name)).toBe(false);
  });
});

describe("moduleNameOf", () => {
  test("reads the name after the LAST directory segment, extension dropped, from any prefix", () => {
    for (const path of ["./tools/echo.ts", "tools/echo.ts", "/abs/project/tools/echo.ts"]) {
      expect(moduleNameOf(path, "tools")).toEqual({ name: "echo", nested: false });
    }
    expect(moduleNameOf("workflows/digest.mjs", "workflows")).toEqual({
      name: "digest",
      nested: false,
    });
    expect(moduleNameOf("tools/page.tsx", "tools")).toEqual({ name: "page", nested: false });
  });

  test("a nested path keeps its slash and says so, so the caller can quote the flat path", () => {
    expect(moduleNameOf("tools/billing/refund.ts", "tools")).toEqual({
      name: "billing/refund",
      nested: true,
    });
  });

  test("the directory is the LAST one of its name on the path", () => {
    expect(moduleNameOf("/home/tools/project/tools/echo.ts", "tools").name).toBe("echo");
  });

  test("the extension set is the one every reader shares", () => {
    for (const ext of [".ts", ".mts", ".js", ".mjs", ".tsx"]) {
      expect(MODULE_EXT_RE.test(`x${ext}`)).toBe(true);
    }
    expect(MODULE_EXT_RE.test("x.json")).toBe(false);
  });
});

describe("isWorkflowDef", () => {
  test("a def is anything with a `run` function; a helper, a declaration or a bag is not", () => {
    expect(isWorkflowDef({ run: async () => ({}) })).toBe(true);
    expect(isWorkflowDef({ description: "x", body: () => ({}) })).toBe(false);
    expect(isWorkflowDef({ status: "completed" })).toBe(false);
    expect(isWorkflowDef("digest")).toBe(false);
    expect(isWorkflowDef(undefined)).toBe(false);
  });
});
