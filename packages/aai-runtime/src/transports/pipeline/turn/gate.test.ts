// Copyright 2026 the AAI authors. MIT license.
// The turn gate's two epochs, the turn chain that checks them, and the
// throw-safe crash logger.

import { describe, expect, test, vi } from "vitest";
import { createTurnChain, createTurnGate, turnCrashLogger } from "./gate.ts";

describe("createTurnGate", () => {
  test("invalidateQueued strands queued turns but not pending history", () => {
    const gate = createTurnGate();
    const queued = gate.queueEpoch();
    const started = gate.historyEpoch();
    gate.invalidateQueued();
    expect(gate.queueCurrent(queued)).toBe(false);
    expect(gate.historyCurrent(started)).toBe(true);
  });

  test("invalidateAll strands both", () => {
    const gate = createTurnGate();
    const queued = gate.queueEpoch();
    const started = gate.historyEpoch();
    gate.invalidateAll();
    expect(gate.queueCurrent(queued)).toBe(false);
    expect(gate.historyCurrent(started)).toBe(false);
    expect(gate.queueCurrent(gate.queueEpoch())).toBe(true);
  });
});

describe("createTurnChain", () => {
  test("turns run one after another, in order", async () => {
    const chain = createTurnChain({ gate: createTurnGate(), isTerminated: () => false });
    const order: string[] = [];
    const first = Promise.withResolvers<void>();
    chain.chain(async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    chain.chain(async () => {
      order.push("b");
    });
    first.resolve();
    await chain.settled();
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  test("a turn queued before invalidateQueued is stranded and onStranded runs instead", async () => {
    const gate = createTurnGate();
    const chain = createTurnChain({ gate, isTerminated: () => false });
    const start = vi.fn(async () => undefined);
    const onStranded = vi.fn();
    chain.chain(start, onStranded);
    gate.invalidateQueued();
    await chain.settled();
    expect(start).not.toHaveBeenCalled();
    expect(onStranded).toHaveBeenCalledTimes(1);
  });

  test("a terminated transport starts nothing", async () => {
    const chain = createTurnChain({ gate: createTurnGate(), isTerminated: () => true });
    const start = vi.fn(async () => undefined);
    chain.chain(start);
    await chain.settled();
    expect(start).not.toHaveBeenCalled();
  });

  test("a rejected turn does not wedge the chain, and settled swallows it", async () => {
    const chain = createTurnChain({ gate: createTurnGate(), isTerminated: () => false });
    const next = vi.fn(async () => undefined);
    chain.chain(() => Promise.reject(new Error("crashed")));
    chain.chain(next);
    await expect(chain.settled()).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("turnCrashLogger", () => {
  test("logs what failed with the error message and session id", () => {
    const log = { error: vi.fn() };
    turnCrashLogger(log, "sid-1")("Turn failed")(new Error("boom"));
    expect(log.error).toHaveBeenCalledWith("Turn failed", { error: "boom", sid: "sid-1" });
  });

  test("a throwing logger does not escape", () => {
    const log = {
      error: () => {
        throw new Error("logger down");
      },
    };
    expect(() => turnCrashLogger(log, "sid")("x")(new Error("boom"))).not.toThrow();
  });
});
