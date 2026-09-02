// Copyright 2026 the AAI authors. MIT license.
/**
 * The module's first test — twelve lines that every audio frame in the product
 * passes through, in both directions, from six call sites. One of them
 * (`telephony/telephony-bridge.ts`) decodes a payload a CARRIER chose.
 */
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { base64ToUint8, uint8ToBase64 } from "./_base64.ts";

/** Byte arrays, plus the windowed views a socket frame and a decode hand over. */
const byteViews = fc
  .record({
    prefix: fc.nat({ max: 5 }),
    body: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 64 }),
    suffix: fc.nat({ max: 5 }),
  })
  .map(({ prefix, body, suffix }) => {
    const buffer = new ArrayBuffer(prefix + body.length + suffix);
    new Uint8Array(buffer).set(body, prefix);
    return new Uint8Array(buffer, prefix, body.length);
  });

describe("uint8ToBase64 / base64ToUint8", () => {
  test("decode inverts encode for every byte string", () => {
    fc.assert(
      fc.property(byteViews, (bytes) => {
        expect([...base64ToUint8(uint8ToBase64(bytes))]).toEqual([...bytes]);
      }),
    );
  });

  test("encoding a VIEW encodes the window, not the whole buffer", () => {
    // The zero-copy comment's actual claim, and the one that would break
    // silently: a `Buffer.from(bytes.buffer)` that dropped the offset and
    // length arguments would encode a neighbour's bytes and pass any
    // round-trip test that generated whole buffers.
    const buffer = new ArrayBuffer(6);
    new Uint8Array(buffer).set([9, 9, 1, 2, 9, 9]);
    expect(uint8ToBase64(new Uint8Array(buffer, 2, 2))).toBe("AQI=");
  });

  test("a decoded value is not a window into Node's shared Buffer pool", () => {
    // `Buffer.from(s, "base64")` allocates out of a 64 KiB pool, so the view
    // this used to return had `buffer.byteLength === 65536` at a nonzero
    // offset: `new Uint8Array(decoded.buffer)` exposed 64 KiB of unrelated
    // pooled memory — other sessions' audio and JSON — from behind a comment
    // that read "zero-copy view over the decoded Buffer's memory". No caller
    // in the repo does that today, which is the only reason it was not a leak.
    const decoded = base64ToUint8("AQIDBA==");
    expect(decoded.byteOffset).toBe(0);
    expect(decoded.buffer.byteLength).toBe(decoded.byteLength);
  });
});

describe("base64ToUint8 on input it did not write", () => {
  test("malformed base64 decodes to nothing instead of arbitrary bytes", () => {
    // The measured defect, and the same one recorded one module over at
    // `workflow-typed-json.ts`'s `bytesFromBase64`: `Buffer.from(s, "base64")`
    // DROPS every character outside the alphabet and returns whatever the
    // survivors decode to, so `"not base64 at all!!"` came back as ten
    // arbitrary bytes with nothing raised — a burst of noise into a caller's
    // ear, or a mulaw frame of garbage, with no way to tell it from real audio.
    expect([...base64ToUint8("not base64 at all!!")]).toEqual([]);
    expect([...base64ToUint8("!!!!")]).toEqual([]);
    // base64URL and over-padding: two more shapes the lenient decoder invented
    // a value for. Every provider and both carriers send standard padded
    // base64, so these are protocol violations rather than dialects.
    expect([...base64ToUint8("-_8=")]).toEqual([]);
    expect([...base64ToUint8("SGVsbG8===")]).toEqual([]);
  });

  test("a sloppy but unambiguous encoding is still accepted", () => {
    // `lastChunkHandling` stays at its default rather than `"strict"`, which
    // is the one place this diverges from `workflow-typed-json.ts`: there both
    // ends of the wire are ours and every string it reads is one it wrote, so
    // it can demand canonical padding. Here the far end is a third party, and
    // each of these has exactly ONE decoding — refusing them would drop real
    // audio to enforce a spelling.
    expect([...base64ToUint8("aGVsbG8")]).toEqual([104, 101, 108, 108, 111]);
    expect([...base64ToUint8("AAB=")]).toEqual([0, 0]);
    expect([...base64ToUint8("SGVs bG8=")]).toEqual([72, 101, 108, 108, 111]);
    expect([...base64ToUint8("")]).toEqual([]);
  });

  test("no string produces bytes that are not its own decoding", () => {
    // Totality from the other side: for an arbitrary string the answer is
    // either the empty array or something that re-encodes to a canonical
    // spelling of itself. There is no third outcome, and no throw — see the
    // module doc for why a throw is not available at these call sites.
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (input) => {
        const bytes = base64ToUint8(input);
        if (bytes.length === 0) return;
        expect([...base64ToUint8(uint8ToBase64(bytes))]).toEqual([...bytes]);
      }),
    );
  });
});
