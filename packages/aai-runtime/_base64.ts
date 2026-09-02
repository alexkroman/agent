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

export function base64ToUint8(base64: string, logger: Logger = consoleLogger): Uint8Array {
  try {
    // Exactly sized and unpooled, unlike the `Buffer.from` view this replaces:
    // that one aliased Node's 64 KiB allocation pool at a nonzero offset, so
    // `new Uint8Array(decoded.buffer)` exposed 64 KiB of unrelated pooled
    // memory from behind a comment that called it a zero-copy view.
    return Uint8Array.fromBase64(base64, { alphabet: "base64" });
  } catch {
    reportDrop(base64.length, logger);
    return NOTHING;
  }
}
