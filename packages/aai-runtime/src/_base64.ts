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
 * ## A drop is REPORTED, and the rate is the whole design
 *
 * The drop used to be silent, which this repo is otherwise right to refuse: a
 * caller hearing nothing with no log line anywhere is the worst outcome
 * available. It is reported now, and three properties are decisions:
 *
 * - **An optional `Logger`, defaulting to `consoleLogger`.** The three CONTAINED
 *   callers pass their own (`s2s.ts`, `telephony/telephony-bridge.ts`,
 *   `transports/openai-realtime-transport.ts`), so a drop lands in the log the
 *   session's other lines are in. The three uncontained ones are provider
 *   openers with no logger to pass — `TtsOpenOptions` carries none, and it is
 *   published from BOTH `@alexkroman1/aai` and `@alexkroman1/aai-runtime`, so
 *   adding a field there is two epoch bumps and two contracted surfaces to buy
 *   one diagnostic. They get the default, which is why the parameter has one:
 *   the guarantee is "reported", and the parameter only decides WHERE.
 * - **One line per {@link BASE64_DROP_REPORT_MS} per logger, carrying the
 *   COUNT.** These are audio frames — ~50 a second per session, and a
 *   mis-negotiated codec makes every one of them malformed — so a line per drop
 *   buries the turn-level events debugging needs. The first drop reports
 *   immediately (an operator learns at once) and the window's line carries the
 *   running total, which is the number that separates one bad frame from a dead
 *   stream. The window is per LOGGER rather than per module, so one session's
 *   burst cannot silence another's first line.
 * - **{@link base64DropCount} is the reading with no log line in it**, for a
 *   spec and for an operator who has the process but not its stdout.
 *
 * An `undefined`-returning sibling (`tryBase64ToUint8`) was the other candidate.
 * It puts the decision at each call site, which is where the context is — and
 * then three of the six sites have nothing to decide WITH, so what it buys is
 * the same silence behind more ceremony. A counter alone was the cheapest and
 * says nothing while a call is live.
 *
 * Two things stay ACCEPTED, and `lastChunkHandling` is left at its default to
 * keep them: an unpadded final chunk (`"aGVsbG8"`) and a final chunk with
 * non-zero trailing bits (`"AAB="`). Each has exactly one decoding, and the
 * far end here is a third party rather than a copy of ourselves — refusing a
 * sloppy spelling would drop real audio. What is refused is what has no single
 * answer: out-of-alphabet characters, over-padding, and base64URL (`-_8=`),
 * all three of which `Buffer.from` decoded to something.
 */

import { consoleLogger, type Logger } from "./runtime-config.ts";

export function uint8ToBase64(bytes: Uint8Array): string {
  // Zero-copy view over the same memory — avoids duplicating every audio chunk.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** No bytes — the answer for a frame whose payload does not spell any. */
const NOTHING = new Uint8Array(0);

/**
 * How long one logger stays quiet after reporting a drop. Ten seconds: short
 * enough that a live call's ongoing loss is visible while it is still live,
 * long enough that a fully malformed 50 fps stream costs six lines a minute.
 */
export const BASE64_DROP_REPORT_MS = 10_000;

/** Per-logger drop bookkeeping — a count to report and a window to report in. */
type DropState = { count: number; nextReportAt: number };

const dropsByLogger = new WeakMap<Logger, DropState>();
let totalDrops = 0;

/**
 * Malformed payloads this module has dropped, since the process started.
 *
 * The observation that needs no log reader. Note a deployed guest holds TWO
 * copies of this package (see the package guide), and each counts its own
 * decodes — which is what it should report, since each also logs its own.
 */
export function base64DropCount(): number {
  return totalDrops;
}

function reportDrop(chars: number, logger: Logger): void {
  totalDrops += 1;
  const state = dropsByLogger.get(logger) ?? { count: 0, nextReportAt: 0 };
  state.count += 1;
  dropsByLogger.set(logger, state);
  const now = Date.now();
  if (now < state.nextReportAt) return;
  state.nextReportAt = now + BASE64_DROP_REPORT_MS;
  logger.warn(
    `base64: dropped a malformed ${chars}-char payload — nothing this string spells; ${state.count} dropped on this logger so far`,
  );
}

/**
 * Whether this runtime has the TC39 `Uint8Array` base64 methods.
 *
 * **Node 24 does NOT, and that cost a deployment its voice.** The decode below
 * used to call `Uint8Array.fromBase64` inside a `try` whose `catch` exists for
 * a MALFORMED payload — so on a runtime without the method the `TypeError` was
 * caught, reported as "a malformed payload", and every audio frame decoded to
 * zero bytes. `assemblyai-frames.ts` drops an empty chunk silently, so a
 * deployed agent transcribed the caller, answered in text, and said nothing.
 * Measured on Vercel `nodejs24.x` (Node v24.18.0): 77 TTS `Audio` frames in,
 * 77 empty, 0 emitted — against 73/0/73 on the same code at Node v26.
 *
 * The scaffold declares `engines: { node: ">=24 <27" }`, so this was never
 * Vercel-specific: any Node 24 or 25 host — a `node:24` image, a CI runner —
 * had silently mute audio on every path this module serves (TTS, S2S,
 * telephony, OpenAI Realtime).
 *
 * Detected ONCE, at module load, rather than per call: a feature test inside
 * the decode is what let a missing method masquerade as bad input.
 */
type NativeFromBase64 = (
  base64: string,
  options: { alphabet: "base64"; lastChunkHandling?: "strict" },
) => Uint8Array;

/**
 * `Uint8Array` narrowed to the one method this module wants, present or not.
 *
 * The root `tsconfig.json` pins `lib` to ES2025 precisely so a proposal-stage
 * builtin cannot compile unnoticed, so the method is not on the declared type
 * and has to be reached through this. Kept as an OBJECT rather than a detached
 * function so the call stays a method call and `this` is still `Uint8Array`.
 */
const NATIVE = Uint8Array as { fromBase64?: NativeFromBase64 };

const HAS_NATIVE_BASE64 = typeof NATIVE.fromBase64 === "function";

/**
 * Standard base64 only — `=` may appear at most twice and only at the end.
 * base64URL (`-_`) is refused here, which is one of the three spellings the
 * module doc requires be refused rather than guessed at.
 */
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * ASCII whitespace, which the native decoder accepts AT ANY POSITION and this
 * module deliberately keeps accepting: the spec allows it and, unlike the
 * spellings refused above, a string with spaces in it has one unambiguous
 * decoding rather than several.
 *
 * Stripped before validation, so the fallback agrees with the native path
 * instead of being quietly stricter than it. It was stricter for one draft —
 * `base64-parity.test.ts` carried no whitespace case and passed anyway, which
 * is why the corpus names each accepted shape explicitly now.
 */
const ASCII_WHITESPACE = /[\t\n\f\r ]/g;

/**
 * How the FINAL chunk is judged — the one axis on which this module's two
 * callers disagree.
 *
 * `"loose"` accepts an unpadded final chunk (`"aGVsbG8"`) and non-zero
 * trailing bits (`"AAB="`), each of which has exactly one decoding; the far
 * end is a third party, and refusing a sloppy spelling would drop real audio.
 * `"strict"` refuses both, which is what `workflow-typed-json.ts` wants of a
 * value we encoded ourselves.
 */
export type LastChunkHandling = "loose" | "strict";

/**
 * A standard-base64 character's 6-bit value, or -1.
 *
 * Arithmetic rather than an index into an alphabet STRING, because that
 * literal is 64 mixed-case characters and Biome's `noSecrets` reads it as a
 * high-entropy credential. Suppressing that would spend an escape-hatch
 * budget on a false positive; the ranges say the same thing and need nothing.
 */
function base64Value(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65; // A-Z
  if (code >= 97 && code <= 122) return code - 97 + 26; // a-z
  if (code >= 48 && code <= 57) return code - 48 + 52; // 0-9
  if (code === 43) return 62; // +
  if (code === 47) return 63; // /
  return -1;
}

/** Do the bits past the last chunk's real bytes read as zero? */
function trailingBitsZero(base64: string, padding: number): boolean {
  if (padding === 0) return true;
  const last = base64.at(-padding - 1);
  const index = last === undefined ? -1 : base64Value(last);
  if (index < 0) return false;
  // One `=` means the final quad carries 3 chars / 2 bytes, so the last char
  // contributes 2 spare low bits; two `=` means 2 chars / 1 byte and 4 spare.
  return (index & (padding === 1 ? 0b11 : 0b1111)) === 0;
}

/**
 * The decode without the native method: VALIDATE, then `Buffer.from`.
 *
 * Exported for `base64-parity.test.ts` only. It is the path every Node 24 and
 * 25 host takes, so on a developer's newer Node it is the half of this module
 * that nothing would otherwise execute — which is exactly how a fallback rots.
 *
 * Validation first is the whole point. `Buffer.from(s, "base64")` is lenient —
 * it drops every character outside the alphabet and returns whatever the
 * survivors spell — which is the defect this module exists to refuse, so the
 * fallback may only reach it once the string is known to be well-formed.
 */
export function decodeWithoutNative(
  base64: string,
  lastChunkHandling: LastChunkHandling,
): Uint8Array | undefined {
  const compact = base64.replace(ASCII_WHITESPACE, "");
  if (!STANDARD_BASE64.test(compact)) return undefined;
  const padding = compact.endsWith("==") ? 2 : Number(compact.endsWith("="));
  // A padded string is a whole number of quads; `"AAAA=="` is over-padding.
  if (padding > 0 && compact.length % 4 !== 0) return undefined;
  // One leftover character spells no byte, under either handling.
  if ((compact.length - padding) % 4 === 1) return undefined;
  if (lastChunkHandling === "strict") {
    if (compact.length % 4 !== 0) return undefined;
    if (!trailingBitsZero(compact, padding)) return undefined;
  }
  const decoded = Buffer.from(compact, "base64");
  // Exactly sized and unpooled: `Buffer.from` returns a view into Node's
  // 64 KiB allocation pool at a nonzero offset, so handing its `.buffer` on
  // would expose 64 KiB of unrelated pooled memory.
  const out = new Uint8Array(decoded.byteLength);
  out.set(decoded);
  return out;
}

/**
 * Decode base64 to bytes, or `undefined` when the input spells none.
 *
 * The one primitive both callers share, so "what counts as base64 here" is
 * decided once. Neither the native path nor the fallback may invent a byte the
 * input does not spell; `base64-parity.test.ts` holds them to the same answers.
 */
export function decodeBase64(
  base64: string,
  lastChunkHandling: LastChunkHandling,
): Uint8Array | undefined {
  if (!HAS_NATIVE_BASE64 || NATIVE.fromBase64 === undefined) {
    return decodeWithoutNative(base64, lastChunkHandling);
  }
  try {
    return NATIVE.fromBase64(base64, {
      alphabet: "base64",
      ...(lastChunkHandling === "strict" ? { lastChunkHandling: "strict" as const } : {}),
    });
  } catch {
    return undefined;
  }
}

export function base64ToUint8(base64: string, logger: Logger = consoleLogger): Uint8Array {
  const bytes = decodeBase64(base64, "loose");
  if (bytes === undefined) {
    reportDrop(base64.length, logger);
    return NOTHING;
  }
  return bytes;
}
