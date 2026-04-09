/**
 * Lightweight zod shim for agent bundles.
 *
 * Agent bundles externalise zod (its 440KB module evaluation is too heavy
 * for guest VMs). This shim provides just enough API surface for
 * `defineAgent()` and `defineTool()` to run: schema construction methods
 * return chainable proxy objects, and `.parse()` passes the input through.
 *
 * Actual schema validation is NOT performed here — it happens on the host
 * side where the real zod is available.
 */

// biome-ignore-all lint/suspicious/noExplicitAny: proxy-based shim requires any

function schema(): unknown {
  const self: Record<string, unknown> = new Proxy(
    { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }) },
    {
      get(_target, prop) {
        if (prop === "parse") return (v: unknown) => v;
        if (prop === "safeParse") return (v: unknown) => ({ success: true, data: v });
        if (prop === "_zod") return { def: {}, traits: new Set() };
        return (..._args: unknown[]) => self;
      },
    },
  );
  return self;
}

function createZ(): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "ZodType") return class {};
        return (..._args: unknown[]) => schema();
      },
    },
  );
}

export const z = createZ();
export const ZodType = class {};
