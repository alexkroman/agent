// Copyright 2026 the AAI authors. MIT license.
// The envelope every session event carries, and the one module UPSTREAM of
// every event schema — including the union in `protocol-events.ts`. It is its
// own file so an event declared in a second module can have the envelope
// without a runtime cycle between two files of eagerly-evaluated zod schemas,
// so the first thing worth claiming is that importing it alone WORKS: the
// schema is usable with nothing else loaded.

import { describe, expect, test } from "vitest";
import { EVENT_ID_PREFIX, SessionEventMetaSchema } from "./protocol-event-meta.ts";

const ID = `${EVENT_ID_PREFIX}01JB2X3Y4Z5A6B7C8D9EFGHJKM`;

describe("EVENT_ID_PREFIX", () => {
  test("is `evt_`, so an id names its own kind", () => {
    // Pinned: the prefix is baked into every stored event id, so changing it
    // orphans every id already written rather than merely renaming a constant.
    expect(EVENT_ID_PREFIX).toBe("evt_");
  });

  test("is the prefix the schema enforces, not a second copy of it", () => {
    // The constant and the rule must not drift: a schema spelling the literal
    // itself would keep accepting old ids after the constant moved.
    expect(SessionEventMetaSchema.safeParse({ id: `${EVENT_ID_PREFIX}1`, at: 0 }).success).toBe(
      true,
    );
  });
});

describe("SessionEventMetaSchema", () => {
  test("accepts a prefixed id and an epoch-millisecond stamp", () => {
    expect(SessionEventMetaSchema.parse({ id: ID, at: 1_760_000_000_000 })).toEqual({
      id: ID,
      at: 1_760_000_000_000,
    });
  });

  test("refuses an id with no prefix — an id that cannot say what it is", () => {
    expect(SessionEventMetaSchema.safeParse({ id: "01JB2X3Y4Z", at: 0 }).success).toBe(false);
    expect(SessionEventMetaSchema.safeParse({ id: "sess_01JB2X", at: 0 }).success).toBe(false);
    expect(SessionEventMetaSchema.safeParse({ id: "", at: 0 }).success).toBe(false);
  });

  test("refuses a stamp that is not a whole, non-negative millisecond count", () => {
    // The writer's clock, in epoch ms. A float or a negative is a bug at the
    // writer, and letting one through puts it in the retained stream forever.
    expect(SessionEventMetaSchema.safeParse({ id: ID, at: -1 }).success).toBe(false);
    expect(SessionEventMetaSchema.safeParse({ id: ID, at: 1.5 }).success).toBe(false);
    expect(SessionEventMetaSchema.safeParse({ id: ID, at: Number.NaN }).success).toBe(false);
    expect(SessionEventMetaSchema.safeParse({ id: ID, at: "0" }).success).toBe(false);
  });

  test("zero is a legal stamp", () => {
    // `nonnegative`, not `positive`: a fake clock in a spec starts at 0, and
    // refusing it would make the envelope untestable from a virtual timer.
    expect(SessionEventMetaSchema.safeParse({ id: ID, at: 0 }).success).toBe(true);
  });

  test("both fields are required — there is no partial envelope", () => {
    expect(SessionEventMetaSchema.safeParse({ id: ID }).success).toBe(false);
    expect(SessionEventMetaSchema.safeParse({ at: 0 }).success).toBe(false);
    expect(SessionEventMetaSchema.safeParse({}).success).toBe(false);
  });

  test("an unknown key is STRIPPED, never rejected", () => {
    // The forward-compatibility rule the whole wire format is read under: an
    // older reader meeting a newer writer's field keeps working. A rejection
    // here would make every envelope addition a breaking change.
    expect(SessionEventMetaSchema.parse({ id: ID, at: 7, span: "trace-1" })).toEqual({
      id: ID,
      at: 7,
    });
  });
});
