import { describe, expect, test } from "vitest";
import { error, interactive, primary, warning } from "./_colors.ts";

describe("_colors", () => {
  test("primary returns a string", () => {
    expect(typeof primary("hello")).toBe("string");
  });

  test("primary output contains the input text", () => {
    expect(primary("hello")).toContain("hello");
  });

  test("interactive returns a string containing input", () => {
    const result = interactive("world");
    expect(typeof result).toBe("string");
    expect(result).toContain("world");
  });

  test("error returns a string containing input", () => {
    const result = error("oops");
    expect(typeof result).toBe("string");
    expect(result).toContain("oops");
  });

  test("warning returns a string containing input", () => {
    const result = warning("careful");
    expect(typeof result).toBe("string");
    expect(result).toContain("careful");
  });
});
