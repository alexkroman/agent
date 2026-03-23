// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { Detail, ErrorLine, Info, interactive, primary, Step, StepInfo, Warn } from "./_ink.tsx";

describe("chalk helpers", () => {
  test("primary wraps text", () => {
    const result = primary("hello");
    expect(result).toContain("hello");
    expect(typeof result).toBe("string");
  });

  test("interactive wraps text", () => {
    const result = interactive("world");
    expect(result).toContain("world");
    expect(typeof result).toBe("string");
  });

  test("primary handles empty string", () => {
    expect(typeof primary("")).toBe("string");
  });

  test("interactive handles empty string", () => {
    expect(typeof interactive("")).toBe("string");
  });
});

describe("Ink components", () => {
  test("Step returns a valid element", () => {
    const el = Step({ action: "Build", msg: "ok" });
    expect(el).toBeTruthy();
    expect(el.props).toBeDefined();
  });

  test("StepInfo returns a valid element", () => {
    const el = StepInfo({ action: "Info", msg: "details" });
    expect(el).toBeTruthy();
  });

  test("Info returns a valid element", () => {
    const el = Info({ msg: "some info" });
    expect(el).toBeTruthy();
  });

  test("Detail returns a valid element", () => {
    const el = Detail({ msg: "detail text" });
    expect(el).toBeTruthy();
  });

  test("Warn returns a valid element", () => {
    const el = Warn({ msg: "warning!" });
    expect(el).toBeTruthy();
  });

  test("ErrorLine returns a valid element", () => {
    const el = ErrorLine({ msg: "error!" });
    expect(el).toBeTruthy();
  });
});
