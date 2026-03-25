import { describe, expect, test } from "vitest";
import { interactive, primary } from "./_ui.ts";

describe("color helpers", () => {
  test("primary returns a string containing input", () => {
    expect(primary("hello")).toContain("hello");
  });

  test("interactive returns a string containing input", () => {
    expect(interactive("world")).toContain("world");
  });
});
