// Copyright 2025 the AAI authors. MIT license.
/**
 * Base64 for audio frames — the encoding every provider socket and both
 * carriers wrap PCM in.
 *
 * ## A decode never invents bytes, and never throws
 *
 * `Buffer.from(s, "base64")` is LENIENT: it drops every character outside the
 * alphabet and returns whatever the survivors decode to, so
 * `"not base64 at all!!"` came back as ten arbitrary bytes with nothing
 * raised. That is the identical defect `workflow-typed-json.ts`'s
 * `bytesFromBase64` records and fixed one module over, and it matters more
 * here: `telephony/telephony-bridge.ts` decodes a payload a CARRIER chose, so
 * a malformed frame put noise into a caller's ear and was indistinguishable
 * from real audio at every layer above.
 *
 * The RULE is shared with that module — never decode to bytes the input does
 * not spell. The ANSWER differs, and deliberately: that one THROWS because its
 * callers classify a throw (a 400, a failed step), while three of this one's
 * six callers decode inside a raw socket `message` handler with no `try` around
 * it (`providers/tts/rime.ts`, `providers/tts/assemblyai-frames.ts`,
 * `step-speak.ts` — the other three, `telephony-bridge.ts`, `s2s.ts` and
 * `transports/openai-realtime-transport.ts`, each wrap theirs and say why).
 * There a throw is an uncaughtException that takes a multi-tenant host down
 * over one bad frame, chosen by a remote party. So the same posture as
 * `host/_path-decode.ts`, for the same reason it took it: an empty result,
 * which every caller here already treats as a frame with nothing to forward.
 *
 * **The cost is that the drop is silent**, which this repo is otherwise right
 * to refuse. Making it legible needs either a `Logger` at the six call sites or
 * an `undefined`-returning variant they each answer — both of which are edits
 * to those files, and neither is a reason to keep decoding garbage in the
 * meantime.
 *
 * Two things stay ACCEPTED, and `lastChunkHandling` is left at its default to
 * keep them: an unpadded final chunk (`"aGVsbG8"`) and a final chunk with
 * non-zero trailing bits (`"AAB="`). Each has exactly one decoding, and the
 * far end here is a third party rather than a copy of ourselves — refusing a
 * sloppy spelling would drop real audio. What is refused is what has no single
 * answer: out-of-alphabet characters, over-padding, and base64URL (`-_8=`),
 * all three of which `Buffer.from` decoded to something.
 */

export function uint8ToBase64(bytes: Uint8Array): string {
  // Zero-copy view over the same memory — avoids duplicating every audio chunk.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** No bytes — the answer for a frame whose payload does not spell any. */
const NOTHING = new Uint8Array(0);

export function base64ToUint8(base64: string): Uint8Array {
  try {
    // Exactly sized and unpooled, unlike the `Buffer.from` view this replaces:
    // that one aliased Node's 64 KiB allocation pool at a nonzero offset, so
    // `new Uint8Array(decoded.buffer)` exposed 64 KiB of unrelated pooled
    // memory from behind a comment that called it a zero-copy view.
    return Uint8Array.fromBase64(base64, { alphabet: "base64" });
  } catch {
    return NOTHING;
  }
}
