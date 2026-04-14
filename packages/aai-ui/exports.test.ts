// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";

describe("aai-ui export surface", () => {
  test("@alexkroman1/aai-ui main export", async () => {
    const mod = await import("@alexkroman1/aai-ui");
    expect(Object.keys(mod).sort()).toMatchSnapshot();
  });
});
