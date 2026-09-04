// Copyright 2026 the AAI authors. MIT license.
/**
 * The two base64 decoders must agree, on every input.
 *
 * `decodeBase64` has a native path (`Uint8Array.fromBase64`) and a fallback,
 * and WHICH one runs is decided by the runtime: Node 26 has the method, Node
 * 24 and 25 do not. So on a developer's machine the fallback is the half of
 * that module nothing executes — and it is the half every deployment on the
 * declared engine floor (`>=24`) depends on.
 *
 * That asymmetry already cost a production deployment its voice. The decode
 * called the native method inside a `try` whose `catch` exists for a malformed
 * payload, so on Node 24 the `TypeError` was caught, reported as bad input,
 * and every TTS audio frame decoded to zero bytes — which
 * `assemblyai-frames.ts` drops silently. Measured on Vercel `nodejs24.x`: 77
 * `Audio` frames in, 77 empty, 0 emitted.
 *
 * These tests pin the fallback directly, and where the native method exists
 * they pin the two against EACH OTHER, so a divergence fails here rather than
 * on whichever host happens to run the other path.
 */

import { describe, expect, test } from "vitest";
import { decodeBase64, decodeWithoutNative, type LastChunkHandling } from "./_base64.ts";

const hasNative = typeof (Uint8Array as { fromBase64?: unknown }).fromBase64 === "function";

/** Inputs whose handling this module's doc calls out by name, plus real audio. */
const CASES = [
  "",
  "AA==",
  "AAEC",
  "aGVsbG8=",
  "aGVsbG8", // unpadded final chunk — accepted loose, refused strict
  "AAB=", // non-zero trailing bits — accepted loose, refused strict
  "not base64 at all!!", // out-of-alphabet
  "-_8=", // base64URL
  "AAAA==", // over-padding
  "AA EC", // ASCII whitespace mid-string — accepted, one unambiguous decoding
  " AAEC\n", // ...and at the edges
  "AA\tE\rC", // ...and tab/CR
  "   ", // whitespace only: decodes to no bytes rather than failing
  "A", // one leftover character
  "AAAAA", // five characters: one leftover after a quad
  Buffer.from(new Uint8Array([0, 1, 2, 253, 254, 255])).toString("base64"),
  Buffer.alloc(3200, 7).toString("base64"), // an audio-frame-sized payload
] as const;

const HANDLINGS: LastChunkHandling[] = ["loose", "strict"];

describe("the fallback decoder", () => {
  test("decodes what the input spells, and refuses what it does not", () => {
    expect(decodeWithoutNative("AAEC", "loose")).toEqual(new Uint8Array([0, 1, 2]));
    expect(decodeWithoutNative("aGVsbG8=", "loose")).toEqual(
      new Uint8Array([104, 101, 108, 108, 111]),
    );
    // The whole reason this module does not just call `Buffer.from`: that is
    // LENIENT, dropping out-of-alphabet characters and returning whatever the
    // survivors spell — ten arbitrary bytes for this string, with nothing
    // raised.
    expect(decodeWithoutNative("not base64 at all!!", "loose")).toBeUndefined();
    expect(decodeWithoutNative("-_8=", "loose")).toBeUndefined();
    expect(decodeWithoutNative("AAAA==", "loose")).toBeUndefined();
    expect(decodeWithoutNative("A", "loose")).toBeUndefined();
  });

  test("`loose` accepts the two sloppy final chunks that have one decoding", () => {
    // A third party is at the other end and each of these spells exactly one
    // thing, so refusing them would drop real audio.
    expect(decodeWithoutNative("aGVsbG8", "loose")).toEqual(
      new Uint8Array([104, 101, 108, 108, 111]),
    );
    expect(decodeWithoutNative("AAB=", "loose")).toEqual(new Uint8Array([0, 0]));
  });

  test("ASCII whitespace is accepted, because it has one decoding", () => {
    // The native decoder allows it at any position and the spec does too, so
    // refusing it here would make the fallback quietly stricter than the path
    // a newer Node takes — a divergence that only shows up on the hosts the
    // fallback exists for.
    expect(decodeWithoutNative("AA EC", "loose")).toEqual(new Uint8Array([0, 1, 2]));
    expect(decodeWithoutNative(" AAEC\n", "strict")).toEqual(new Uint8Array([0, 1, 2]));
    expect(decodeWithoutNative("   ", "loose")).toEqual(new Uint8Array(0));
  });

  test("`strict` refuses both, for a value we encoded ourselves", () => {
    expect(decodeWithoutNative("aGVsbG8", "strict")).toBeUndefined();
    expect(decodeWithoutNative("AAB=", "strict")).toBeUndefined();
    expect(decodeWithoutNative("AAEC", "strict")).toEqual(new Uint8Array([0, 1, 2]));
  });

  test("the result is exactly sized and owns its buffer", () => {
    // `Buffer.from` returns a view into Node's 64 KiB allocation pool at a
    // nonzero offset, so handing its `.buffer` on would expose unrelated
    // pooled memory from behind a comment calling it a zero-copy view.
    const bytes = decodeWithoutNative(Buffer.alloc(64, 3).toString("base64"), "loose");
    expect(bytes).toBeDefined();
    expect(bytes?.byteOffset).toBe(0);
    expect(bytes?.buffer.byteLength).toBe(64);
  });

  test("a 3200-byte audio frame survives the round trip", () => {
    // The size the TTS path actually carries, and the case that was returning
    // zero bytes on every Node 24 host.
    const frame = Buffer.alloc(3200, 7);
    const decoded = decodeWithoutNative(frame.toString("base64"), "loose");
    expect(decoded).toEqual(new Uint8Array(frame));
  });
});

// `runIf` on the DESCRIBE, not on each test: Biome's `noMisplacedAssertion`
// does not recognise `test.runIf(...)` as a test call and reports every
// `expect` inside one as misplaced — the same blind spot this repo's own
// assertion gate had with `test.concurrent`. The skip stays visible either way.
describe.runIf(hasNative)("native and fallback agree", () => {
  test("on every documented case, under both handlings", () => {
    for (const handling of HANDLINGS) {
      for (const input of CASES) {
        const native = decodeBase64(input, handling);
        const fallback = decodeWithoutNative(input, handling);
        // Named so a failure says which input and which handling diverged.
        expect(fallback, `${JSON.stringify(input)} / ${handling}`).toEqual(native);
      }
    }
  });

  test("the corpus really exercises both verdicts", () => {
    // A parity test over inputs that all decode, or all fail, would pass while
    // checking half the contract.
    const verdicts = CASES.map((input) => decodeWithoutNative(input, "strict") !== undefined);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });
});
