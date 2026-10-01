// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { makeAgent, makeLogger } from "../_test-utils.ts";
import { mergeBuiltinSurface } from "./builtin-surface.ts";

const schema = (name: string) => ({
  type: "function" as const,
  name,
  description: name,
  parameters: { type: "object" as const, properties: {}, required: [] },
});

describe("mergeBuiltinSurface", () => {
  test("a provided tool wins over the builtin of its name, which leaves dispatch and schemas", () => {
    const merged = mergeBuiltinSurface(
      makeAgent({ builtinTools: ["web_search", "calculate"] }),
      undefined,
      { schemas: [schema("web_search")] },
    );
    expect(merged.schemas.map((s) => s.name)).toEqual(["web_search", "calculate"]);
    expect(Object.keys(merged.toolset.list())).toEqual(["calculate"]);
  });

  test("a builtin the author DECLARED and a file shadows is logged; an unset default is not", () => {
    const declared = makeLogger();
    mergeBuiltinSurface(
      makeAgent({ builtinTools: ["web_search"] }),
      undefined,
      {
        schemas: [schema("web_search")],
      },
      declared,
    );
    expect(declared.info).toHaveBeenCalledTimes(1);

    const defaulted = makeLogger();
    mergeBuiltinSurface(makeAgent(), undefined, { schemas: [schema("think")] }, defaulted);
    expect(defaulted.info).not.toHaveBeenCalled();
  });

  test("provided schemas and guidance come first, builtins after", () => {
    const merged = mergeBuiltinSurface(makeAgent({ builtinTools: ["calculate"] }), undefined, {
      schemas: [schema("mine")],
      guidance: ["Use mine first."],
    });
    expect(merged.schemas.map((s) => s.name)).toEqual(["mine", "calculate"]);
    expect(merged.guidance[0]).toBe("Use mine first.");
  });
});
