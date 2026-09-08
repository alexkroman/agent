// Copyright 2026 the AAI authors. MIT license.
/**
 * The containment claims are the ones worth pinning: only this module's own
 * sentinel is caught, and the value the failing helper built comes back out
 * unchanged.
 */
import { describe, expect, test } from "vitest";

import { failable, orFail } from "./tool-failure-flow.ts";
import { isToolFailure, type ToolFailure, toolFailure } from "./utils.ts";

type Order = { id: string; total: number };

function findOrder(id: string): Order | ToolFailure {
  return id === "A1" ? { id, total: 42 } : toolFailure(`No order ${id}.`);
}

describe("orFail inside failable", () => {
  test("passes a value straight through", () => {
    const total = failable((id: string) => orFail(findOrder(id)).total);
    expect(total("A1")).toBe(42);
  });

  test("abandons with the failure the helper built, unchanged", () => {
    const total = failable((id: string) => orFail(findOrder(id)).total);
    // The exact sentence, not a re-worded one: what reaches the model is what
    // the helper that knows the domain wrote.
    expect(total("ZZ")).toEqual({ error: "No order ZZ." });
  });

  test("short-circuits — nothing after the failing lookup runs", () => {
    const ran: string[] = [];
    const run = failable((id: string) => {
      const order = orFail(findOrder(id));
      ran.push("after");
      return order.total;
    });
    expect(isToolFailure(run("ZZ"))).toBe(true);
    expect(ran).toEqual([]);
  });

  test("forwards the FIRST failure in a chain", () => {
    const run = failable((a: string, b: string) => {
      const first = orFail(findOrder(a));
      const second = orFail(findOrder(b));
      return first.total + second.total;
    });
    expect(run("ZZ", "YY")).toEqual({ error: "No order ZZ." });
    expect(run("A1", "YY")).toEqual({ error: "No order YY." });
    expect(run("A1", "A1")).toBe(84);
  });
});

describe("what failable does NOT catch", () => {
  test("an ordinary throw passes through", () => {
    // The containment property: a bug in a wrapped body still reaches the tool
    // executor and is still reported as a tool that threw, rather than being
    // quietly turned into a failure the model is asked to recover from.
    const run = failable(() => {
      throw new TypeError("boom");
    });
    expect(run).toThrow(TypeError);
  });

  test("an object that merely LOOKS like the sentinel passes through", () => {
    const impostor = Object.assign(new Error("nope"), { failure: { error: "spoofed" } });
    const run = failable(() => {
      throw impostor;
    });
    expect(run).toThrow(impostor);
  });

  test("orFail outside a failable escapes rather than being swallowed", () => {
    expect(() => orFail(toolFailure("loose"))).toThrow("loose");
  });
});

describe("async bodies", () => {
  async function loadOrder(id: string): Promise<Order | ToolFailure> {
    await Promise.resolve();
    return findOrder(id);
  }

  test("resolve to the value", async () => {
    const run = failable(async (id: string) => orFail(await loadOrder(id)).total);
    await expect(run("A1")).resolves.toBe(42);
  });

  test("resolve to the failure rather than rejecting", async () => {
    // A rejection is invisible to the sync `catch`, so the handler has to be
    // attached to the promise — this is the case that catches forgetting to.
    const run = failable(async (id: string) => orFail(await loadOrder(id)).total);
    await expect(run("ZZ")).resolves.toEqual({ error: "No order ZZ." });
  });

  test("still reject on an ordinary error", async () => {
    const run = failable(async () => {
      await Promise.resolve();
      throw new TypeError("boom");
    });
    await expect(run()).rejects.toThrow(TypeError);
  });

  test("a body that returns a thenable without being async is handled too", async () => {
    const run = failable((id: string) => loadOrder(id).then((o) => orFail(o).total));
    await expect(run("ZZ")).resolves.toEqual({ error: "No order ZZ." });
  });
});

describe("a body that also returns a ToolFailure directly", () => {
  test("is absorbed by the same union", () => {
    const run = failable((id: string) => {
      if (id === "") return toolFailure("Say an order number.");
      return orFail(findOrder(id)).total;
    });
    expect(run("")).toEqual({ error: "Say an order number." });
    expect(run("ZZ")).toEqual({ error: "No order ZZ." });
    expect(run("A1")).toBe(42);
  });
});
