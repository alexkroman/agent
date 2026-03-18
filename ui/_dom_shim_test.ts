// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { DOMParser, installDomShim } from "./_dom_shim.ts";

describe("_dom_shim", () => {
  test("installDomShim sets up globalThis.HTMLElement", () => {
    installDomShim();
    const g = globalThis as unknown as Record<string, unknown>;
    expect(g.HTMLElement).toBeDefined();
    expect(typeof g.HTMLElement).toBe("function");
  });

  test("DOMParser can parse HTML", () => {
    const doc = new DOMParser().parseFromString(
      "<html><body><p>hello</p></body></html>",
      "text/html",
    );
    expect(doc).toBeDefined();
    const p = doc.querySelector("p");
    expect(p).toBeDefined();
    expect(p?.textContent).toBe("hello");
  });
});
