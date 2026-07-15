// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { errorDetail, errorMessage, isTextAssetPath } from "./utils.ts";

describe("errorMessage", () => {
  test("extracts message from Error instance", () => {
    expect(errorMessage(new Error("something broke"))).toBe("something broke");
  });

  test("converts string to string", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });

  test("converts number to string", () => {
    expect(errorMessage(42)).toBe("42");
  });

  test("converts null to string", () => {
    expect(errorMessage(null)).toBe("null");
  });

  test("converts undefined to string", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("errorDetail", () => {
  test("returns stack trace when available", () => {
    const err = new Error("something broke");
    const result = errorDetail(err);
    expect(result).toBe(err.stack);
    expect(result).toContain("something broke");
  });

  test("returns message when stack is undefined", () => {
    const err = new Error("no stack");
    Object.defineProperty(err, "stack", { value: undefined });
    expect(errorDetail(err)).toBe("no stack");
  });

  test("converts string to string", () => {
    expect(errorDetail("plain string")).toBe("plain string");
  });

  test("converts null to string", () => {
    expect(errorDetail(null)).toBe("null");
  });

  test("converts undefined to string", () => {
    expect(errorDetail(undefined)).toBe("undefined");
  });
});

describe("isTextAssetPath", () => {
  test.each([
    "index.html",
    "assets/app.js",
    "styles.css",
    "data.json",
    "icon.svg",
    "app.js.map",
  ])("treats %s as text", (p) => {
    expect(isTextAssetPath(p)).toBe(true);
  });

  test.each([
    "logo.png",
    "font.woff2",
    "img.jpg",
    "clip.mp3",
    "module.wasm",
    "noext",
  ])("treats %s as binary", (p) => {
    expect(isTextAssetPath(p)).toBe(false);
  });

  test("is case-insensitive on the extension", () => {
    expect(isTextAssetPath("INDEX.HTML")).toBe(true);
    expect(isTextAssetPath("LOGO.PNG")).toBe(false);
  });
});
