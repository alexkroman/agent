import { describe, expect, test } from "vitest";
import { asMessagePort } from "./_capnweb_transport.ts";

describe("asMessagePort", () => {
  test("adds start() if missing", () => {
    const obj = {
      postMessage: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const result = asMessagePort(obj as any);
    expect(typeof result.start).toBe("function");
  });

  test("adds close() if missing", () => {
    const obj = {
      postMessage: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const result = asMessagePort(obj as any);
    expect(typeof result.close).toBe("function");
  });

  test("preserves existing start() and close()", () => {
    const start = () => {};
    const close = () => {};
    const obj = {
      postMessage: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      start,
      close,
    };
    const result = asMessagePort(obj as any);
    expect(result.start).toBe(start);
    expect(result.close).toBe(close);
  });

  test("returns the same object reference", () => {
    const obj = {
      postMessage: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const result = asMessagePort(obj as any);
    expect(result).toBe(obj);
  });
});
