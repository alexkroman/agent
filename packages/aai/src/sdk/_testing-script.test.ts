// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { scriptRouter } from "./_testing-script.ts";

describe("scriptRouter", () => {
  test("`{ reply }` answers every key, and names no routes", () => {
    const router = scriptRouter<string, number>({ reply: "same" }, "misuse");
    expect(router.answer("a", 1)).toBe("same");
    expect(router.answer("", 2)).toBe("same");
    expect(router.routed).toEqual([]);
  });

  test("`{ routes }` answers by key, `undefined` for an unrouted one", () => {
    const router = scriptRouter<string, number>({ routes: { a: "A", b: "B" } }, "misuse");
    expect(router.answer("b", 1)).toBe("B");
    expect(router.answer("c", 1)).toBeUndefined();
    expect(router.routed).toEqual(["a", "b"]);
  });

  test("a function route is applied to the call", () => {
    const route = vi.fn((call: number) => `call ${call}`);
    const router = scriptRouter<string, number>({ routes: { a: route } }, "misuse");
    expect(router.answer("a", 7)).toBe("call 7");
    expect(route).toHaveBeenCalledWith(7);
  });

  test.for([{}, { reply: "x", routes: {} }, "bare", null])(
    "throws the misuse sentence at bind for %j",
    (script) => {
      expect(() => scriptRouter(script as Parameters<typeof scriptRouter>[0], "say which")).toThrow(
        "say which",
      );
    },
  );
});
