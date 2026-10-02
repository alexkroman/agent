// Copyright 2026 the AAI authors. MIT license.
/**
 * The slot half of the session-state case list, and the helpers every case
 * mints its keys and values from.
 *
 * The list runs here over a FRESH reference backend per case — the opposite of
 * the memory arm in `conformance.test.ts`, which shares one backend the way the
 * Postgres arm must. Green under both is the claim that no case leans on
 * another's leftovers, nor on a store some earlier case filled.
 */

import { describe, expect, test } from "vitest";
import { createMemoryStateBackend } from "./backends/memory.ts";
import {
  json,
  meaningOf,
  meaningOfEvents,
  sessionStateIds,
  sessionStateSlotConformance,
  slots,
} from "./conformance-slots.ts";

describe("the case helpers", () => {
  test("sessionStateIds mints distinct ids under its label", () => {
    const next = sessionStateIds("lbl");
    const [a, b] = [next(), next()];
    expect(a).toMatch(new RegExp(`^sess-lbl-${process.pid}-`));
    expect(a).not.toBe(b);
  });

  test("json serializes as the store does, and undefined as null", () => {
    expect(json({ a: 1 })).toBe('{"a":1}');
    expect(json(undefined)).toBe("null");
  });

  test("slots and meaningOf round-trip a value map", () => {
    const stored = slots({ cart: ["apple"], total: 1.5 });
    expect(stored).toEqual(
      new Map([
        ["cart", '["apple"]'],
        ["total", "1.5"],
      ]),
    );
    expect(meaningOf(stored)).toEqual({ cart: ["apple"], total: 1.5 });
  });

  test("meaningOfEvents parses each event and keeps its index", () => {
    expect(meaningOfEvents([{ index: 3, json: '{"type":"x"}' }])).toEqual([
      { index: 3, event: { type: "x" } },
    ]);
  });
});

sessionStateSlotConformance({
  label: "memory, fresh per case",
  backend: () => createMemoryStateBackend(),
  uid: sessionStateIds("slots-fresh"),
});
