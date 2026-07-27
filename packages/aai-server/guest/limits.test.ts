// Copyright 2026 the AAI authors. MIT license.
// `limits.ts` is bundled into the guest and must therefore keep zero imports,
// so it cannot import the SDK constants it mirrors. These assertions are what
// stops the two sides drifting: they are the reason the duplication is safe.

import { TOOL_EXECUTION_TIMEOUT_MS } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import * as limits from "./limits.ts";

describe("guest limits mirror the SDK constants", () => {
  test("tool execution timeout", () => {
    expect(limits.TOOL_TIMEOUT_MS).toBe(TOOL_EXECUTION_TIMEOUT_MS);
  });

  test("limits.ts stays import-free so it can be bundled into the guest", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./limits.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
