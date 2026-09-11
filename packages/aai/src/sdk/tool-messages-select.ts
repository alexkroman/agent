// Copyright 2026 the AAI authors. MIT license.
/**
 * Choosing WHICH of a tool's declared messages a given call gets — the pure
 * half of `tool-messages.ts`, split from it so the whole decision is a function
 * of `(declaration, arguments, random)` and can be stated in a unit test
 * without a session, a transport or a clock.
 *
 * Three rules live here and nowhere else:
 *
 * - a message whose `when` the call's arguments fail is not eligible at all;
 * - among the eligible ones for a single moment, one is DRAWN — they are
 *   variants, and an agent that repeats itself word for word on every tool call
 *   is the thing this feature is supposed to fix rather than cause;
 * - and for the delay ladder, "a single moment" means "the same `afterMs`".
 *   That is the whole staged-versus-variant rule: entries sharing a timing are
 *   alternative phrasings of one rung, entries with different timings are
 *   successive rungs.
 *
 * @internal
 */

import { pickOne, type RandomSource } from "./random.ts";
import type { ToolDelayedMessage, ToolMessageBase, ToolMessageCondition } from "./tool-messages.ts";

/**
 * Does one condition hold for this call's arguments?
 *
 * An ordering operator against anything but two numbers answers `false` rather
 * than throwing or coercing: the model picks these values, so a comparison it
 * makes nonsense of must cost the call a filler line at worst.
 */
function conditionHolds(
  cond: ToolMessageCondition,
  args: Readonly<Record<string, unknown>>,
): boolean {
  const actual = args[cond.arg];
  switch (cond.op ?? "eq") {
    case "eq":
      return actual === cond.value;
    case "neq":
      return actual !== cond.value;
    default:
      break;
  }
  if (typeof actual !== "number" || typeof cond.value !== "number") return false;
  switch (cond.op) {
    case "gt":
      return actual > cond.value;
    case "gte":
      return actual >= cond.value;
    case "lt":
      return actual < cond.value;
    default:
      return actual <= cond.value;
  }
}

/** Every condition must hold; a message with none always matches. */
export function matchesToolConditions(
  when: readonly ToolMessageCondition[] | undefined,
  args: Readonly<Record<string, unknown>>,
): boolean {
  if (when === undefined || when.length === 0) return true;
  return when.every((cond) => conditionHolds(cond, args));
}

/** The eligible subset, in declaration order. */
export function eligibleToolMessages<T extends ToolMessageBase>(
  list: readonly T[] | undefined,
  args: Readonly<Record<string, unknown>>,
): readonly T[] {
  if (list === undefined) return [];
  return list.filter((m) => matchesToolConditions(m.when, args));
}

/**
 * One of the eligible messages, drawn — the VARIANT rule.
 *
 * `undefined` when the tool declared none for this kind or when the call's
 * arguments rule every one of them out, which is a legitimate outcome and not
 * a failure: a tool may declare a start line for a refund and nothing at all
 * for a lookup.
 */
export function selectToolMessage<T extends ToolMessageBase>(
  list: readonly T[] | undefined,
  args: Readonly<Record<string, unknown>>,
  random: RandomSource = Math.random,
): T | undefined {
  return pickOne(eligibleToolMessages(list, args), random);
}

/** One rung of a delay ladder: what to say, and how long into the call. */
export type DelayedRung = {
  /** Milliseconds from the start of the tool call. */
  afterMs: number;
  content: string;
};

/**
 * The ladder this call gets: one line per DISTINCT `afterMs`, ascending.
 *
 * Grouping by timing before drawing is the whole rule — draw first and a
 * three-variant 3000ms rung beside an 8000ms one would give a coin-flip between
 * "a line at 3s" and "a line at 8s" instead of both. Offsets are absolute (from
 * the call's start), so a 3000/8000 ladder speaks at 3s and 8s, and a rung
 * whose moment has already passed when the tool settles simply never fires.
 */
export function planDelayedLadder(
  list: readonly ToolDelayedMessage[] | undefined,
  args: Readonly<Record<string, unknown>>,
  random: RandomSource = Math.random,
): DelayedRung[] {
  const eligible = eligibleToolMessages(list, args);
  const byTiming = new Map<number, ToolDelayedMessage[]>();
  for (const message of eligible) {
    const rung = byTiming.get(message.afterMs);
    if (rung === undefined) byTiming.set(message.afterMs, [message]);
    else rung.push(message);
  }
  return [...byTiming.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([afterMs, variants]) => {
      const chosen = pickOne(variants, random);
      return chosen === undefined ? [] : [{ afterMs, content: chosen.content }];
    });
}
