// Copyright 2026 the AAI authors. MIT license.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as z from "zod";
// Side-effect import, and it must stay above the `z.object` calls below for
// the same reason it leads main.tsx — see zod-jitless.ts.
import "./zod-jitless.ts";

describe("zod jitless", () => {
  it("sets the flag zod reads instead of probing", () => {
    expect(z.core.globalConfig.jitless).toBe(true);
  });

  /**
   * The real claim, and the only one that would catch the flag being set too
   * late or under the wrong name: zod must never REACH `new Function`.
   *
   * Asserted by standing in for the constructor rather than by reading
   * `allowsEval`, which is internal and — being `cached()` — answers from a
   * probe some earlier module may already have run. What the studio's CSP
   * blocks is the call, so the call is what this counts.
   */
  it("constructs and parses an object schema without reaching `new Function`", () => {
    const RealFunction = globalThis.Function;
    let reached = 0;
    globalThis.Function = new Proxy(RealFunction, {
      construct: (target, args, newTarget) => {
        reached++;
        return Reflect.construct(target, args, newTarget);
      },
      apply: (target, self, args) => {
        reached++;
        return Reflect.apply(target, self, args);
      },
    });

    let parsed: unknown;
    try {
      // Constructed INSIDE the proxy's window on purpose: zod decides in the
      // object schema's init, so a schema built at module scope would have
      // probed before this test could see it.
      const schema = z.object({ slug: z.string(), count: z.number() });
      parsed = schema.parse({ slug: "demo", count: 1 });
    } finally {
      globalThis.Function = RealFunction;
    }

    expect(reached).toBe(0);
    // The fallback parser still has to be a working one.
    expect(parsed).toEqual({ slug: "demo", count: 1 });
  });

  /**
   * `main.tsx` must import this module FIRST. The failure is silent — the app
   * behaves identically either way and only the DevTools violation comes back
   * — so nothing else in the suite would notice a sorted-away import.
   */
  it("is main.tsx's first import", () => {
    const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf-8");
    const firstImport = main.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "./zod-jitless.ts";');
  });
});
