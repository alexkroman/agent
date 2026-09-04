// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:utils` epoch 1.
 *
 * The narration a step writes and the page renders, plus the small vocabulary a
 * tool body reaches for — written the way it was authored at epoch 1. It must
 * keep compiling for as long as epoch 1 is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Epoch 2 ADDED `formatMoney`. That is the safest shape a capability can move
 * in: a name nobody referenced cannot break a caller, no existing signature
 * narrowed, and no behaviour under an unchanged call changed.
 *
 * Nothing below names it, deliberately — an epoch-1 body formatting an amount
 * wrote `` `$${n.toFixed(2)}` `` inline, which is exactly why epoch 2 exists
 * ({@link priceLine} keeps that spelling, and still compiles). This file is
 * evidence about epoch 1's surface, not a demonstration of the better way.
 *
 * ## The direction a break would come from
 *
 * Almost everything here is a pure function of values a body already holds, so
 * what freezes it is the CALL: a narrowed parameter or a second required
 * argument reddens at the call site below. Two names are not that shape and are
 * frozen deliberately from the other side. {@link ACQUIRE} constructs a
 * `KeyedLockOptions` and hands it to `withLock`, which is the position an
 * options bag breaks in — a field removed, or an optional one made required.
 * And {@link isLockTimeout} narrows a `catch` to `KeyedLockTimeoutError` and
 * reads `key` off it, which is the position an ERROR breaks in: a class that
 * stopped carrying the key, or stopped being exported as a value, fails here,
 * where a class that gained a field does not.
 */

import {
  countWords,
  createKeyedLock,
  decodeHtmlEntities,
  errorDetail,
  errorMessage,
  formatBytes,
  formatDuration,
  isRecord,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  omitUndefined,
  plural,
  pushCapped,
  responseErrorMessage,
  safeJsonParse,
  withLock,
} from "../../../sdk/utils.ts";

/** The progress line a transcription step reports, epoch 1. */
export function report(bytes: number, ms: number, text: string): string {
  const words = countWords(text);
  return `${formatBytes(bytes)} of audio, ${formatDuration(ms)}, ${words} ${plural(words, "word")}.`;
}

/**
 * An amount of money as an epoch-1 body wrote one.
 *
 * Left inline on purpose: this is the drift epoch 2's `formatMoney` was added
 * to end, and an epoch-1 file that still spells it by hand has to keep working.
 */
export function priceLine(total: number): string {
  return `$${total.toFixed(2)} due`;
}

/** A feed title off the wire, entity-decoded the way epoch 1 published. */
export function titleOf(raw: string): string {
  return decodeHtmlEntities(raw).trim();
}

/** A JSON body a step read, narrowed without a cast. */
export function idOf(text: string): string | undefined {
  const parsed = safeJsonParse(text);
  if (!isRecord(parsed)) return undefined;
  return typeof parsed.id === "string" ? parsed.id : undefined;
}

/** A capped activity log — the shape every stateful template keeps. */
export function note(log: string[], line: string): readonly string[] {
  return pushCapped(log, line, 50);
}

/** An options object with the absent fields dropped rather than set undefined. */
export function requestInit(token: string | undefined): Record<string, unknown> {
  return omitUndefined({ method: "POST", authorization: token });
}

/** The two error readers, as a `catch` block used them. */
export async function describeFailure(err: unknown, response: Response): Promise<string> {
  return `${errorMessage(err)} / ${await responseErrorMessage(response)}`;
}

/**
 * The same failure for the OTHER reader.
 *
 * `errorMessage` is written for a model or a caller — one sentence, no stack —
 * and a server log wants the opposite. Keeping both readers in one line is what
 * an epoch-1 body did rather than choosing, because choosing means either a log
 * with nothing to debug from or a tool result quoting a stack trace back at the
 * person on the phone.
 */
export function logLine(err: unknown): string {
  return `${errorMessage(err)}\n${errorDetail(err)}`;
}

/** Serialized work per key — epoch 1's concurrency primitive. */
export function makeLock(): KeyedLock {
  return createKeyedLock();
}

/**
 * How long a caller waits for a key somebody else holds.
 *
 * An unbounded wait is the default and is the wrong one inside a tool call: the
 * LLM loop runs tool calls concurrently, so two mutators of one resource queue
 * behind each other and a holder that never releases takes the whole turn down
 * with it, with nothing in the transcript saying which key it was.
 */
const ACQUIRE: KeyedLockOptions = { timeoutMs: 5000 };

/** And the free-function form beside it. */
export async function guarded(lock: KeyedLock, key: string): Promise<number> {
  return await withLock(lock, key, async () => 1, ACQUIRE);
}

/**
 * Told apart from the work's own failure — which is the point of the deadline
 * having a named error rather than a message.
 *
 * `withLock` rejects with whatever the body threw AND with this, so a `catch`
 * that could not distinguish them would report a contended key as a broken
 * tool. `key` is read off it because that is the field a report needs: the fact
 * that something timed out is much less useful than which resource it was
 * queued on.
 */
export function isLockTimeout(err: unknown, key: string): boolean {
  return err instanceof KeyedLockTimeoutError && err.key === key;
}
