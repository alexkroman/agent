// Copyright 2026 the AAI authors. MIT license.
/**
 * What keeps an author's value STORABLE — the second of the codec's two escapes.
 *
 * `workflow-typed-json.test.ts` owns the codec's round trip and the tagged
 * envelopes; this file owns `workflow-typed-json-escape.ts`, which had no suite
 * of its own, and specifically the escape that exists because PostgreSQL cannot
 * hold every string JavaScript can.
 */

import { describe, expect, test } from "vitest";
import {
  decodeStorageJson,
  decodeTypedJson,
  encodeStorageJson,
  encodeTypedJson,
} from "./workflow-typed-json.ts";

/** Encode then decode, which is what crossing the wire does. */
const roundTrip = (value: unknown): unknown => decodeTypedJson(encodeTypedJson(value));

/** The same, over the storage RPC's codec, which also carries dates. */
const storageRoundTrip = (value: unknown): unknown => decodeStorageJson(encodeStorageJson(value));

describe("a value PostgreSQL cannot store", () => {
  // Both database backends bind these through `jsonb`, which refuses a NUL and
  // an unpaired surrogate outright. The driver's refusal is a raw SQLSTATE — a
  // plain `Error`, i.e. a retryable 503 — so the engine spent a message's whole
  // attempt budget on a value that could never be accepted, while the MEMORY
  // backend took it happily: `aai dev` works, deployed fails.
  //
  // The claim these cases make is that the value round-trips AND that the
  // codec's text no longer contains the unit. `journal-conformance-codec.ts` is
  // what holds all four backends to the round trip, and its scenario arms are
  // what put it in front of a real Postgres.
  //
  // Every one of these is spelled as an ESCAPE. A raw NUL makes a file BINARY to
  // `git grep`, which silently exempts it from every line rule and from
  // `check:hatches` — this repository has paid for that three times.
  const NUL = "\u0000";
  const LONE_HIGH = "\ud83d";
  const LONE_LOW = "\udc4b";
  const ESC = "\u0001";

  test.each([
    ["a NUL", `before${NUL}after`],
    ['a lone HIGH surrogate, which is `"👋".slice(0, 1)`', `wave ${LONE_HIGH}`],
    ["a lone LOW surrogate", `${LONE_LOW} tail`],
    ["the escape's own sentinel", `esc${ESC}aped`],
    ["a string spelling an escape sequence", `${ESC}u0041`],
    ["several at once", `${NUL}${LONE_HIGH}${NUL}`],
  ])("%s survives the storage codec and never reaches the wire", (_label, value) => {
    expect(storageRoundTrip(value)).toBe(value);
    const wire = encodeStorageJson(value);
    expect(wire).not.toContain(NUL);
    expect(wire).not.toContain(LONE_HIGH);
    expect(wire).not.toContain(LONE_LOW);
  });

  test("a KEY is escaped too, a key being a string with nowhere to hide", () => {
    // It cannot be enveloped out of the problem the way a value could.
    const value = { [`k${NUL}ey`]: 1, [LONE_HIGH]: 2 };
    expect(encodeStorageJson(value)).not.toContain(NUL);
    expect(storageRoundTrip(value)).toEqual(value);
  });

  test("it survives the QUEUE codec as well, both codecs sharing the escape", () => {
    expect(roundTrip({ note: `x${NUL}y` })).toEqual({ note: `x${NUL}y` });
  });

  test("a WELL-FORMED surrogate pair is left exactly alone", () => {
    // Only an unpaired half is unstorable, and escaping a real emoji would make
    // every stored transcript longer for nothing.
    expect(encodeStorageJson("wave 👋")).toBe(JSON.stringify("wave 👋"));
    expect(storageRoundTrip("wave 👋")).toBe("wave 👋");
  });

  test("a string holding none of them encodes BYTE-IDENTICALLY to plain JSON", () => {
    // The fast path, which is every string in every real payload.
    const value = { topic: "otters", nested: ["a", "b"] };
    expect(encodeStorageJson(value)).toBe(JSON.stringify(value));
  });

  test("the escape composes with the RESERVED-key rename in both directions", () => {
    // `__type` holds none of the escapable units and nothing escapes INTO it, so
    // the two escapes are independent — this is the case that would catch one
    // being applied in an order the other cannot invert.
    const value = { __type: `Uint8Array${NUL}`, ___type: "Date", data: "aGVsbG8=" };
    expect(storageRoundTrip(value)).toEqual(value);
  });

  test("bytes and a date still cross as themselves beside an escaped string", () => {
    const value = { bytes: new Uint8Array([1, 2]), at: new Date(1_700_000_000_000), s: NUL };
    expect(storageRoundTrip(value)).toEqual(value);
  });
});
