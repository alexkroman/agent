// Copyright 2026 the AAI authors. MIT license.
/**
 * A session's memory of tool calls that FAILED, so the model cannot spend a
 * step re-sending one, and is shown what it has already tried.
 *
 * ## Why
 *
 * A lookup on a value the caller spoke fails mostly because the value was
 * mis-heard, and the recovery is to CHANGE something: another spelling,
 * another identifier, or the caller spelling it out. Models re-send the exact
 * failed call anyway — 44 identical resends in 72 replayed recoveries of
 * failed account lookups (tau2 retail) — even though the failed result is in
 * the history, because a bare `Error: User not found` does not say WHICH
 * values missed, and the earlier attempts are scattered across turns.
 *
 * The budget in `../_prepare-step.ts` used to catch a repeat AFTER it ran and
 * end the turn with `toolChoice: "none"`, so the repeat cost a call and the
 * rest of the model's recovery. This refuses the repeat BEFORE it runs — the
 * tool (in host mode, the harness on the far side of the relay) never sees it
 * — with a result that says what to do instead, and the turn goes on. On the
 * same replay that halved the resends (44 → 18) and moved authentication from
 * 76% to 82% of recoveries.
 *
 * ## What it does
 *
 * - **{@link FailedCallMemo.refuse}** — before a call runs: the same tool with
 *   the same (canonical) arguments already failed → a `repeated_failure`
 *   refusal quoting that failure.
 * - **{@link FailedCallMemo.settle}** — after a call runs: a failure is
 *   remembered and answered with the list of every failed call so far, for the
 *   MODEL's copy only (the tool's own string stays what the history and the
 *   client's `tool.completed` carry). A success forgets everything: something
 *   in the world may have changed, and a remembered failure must never refuse a
 *   call that would now succeed.
 *
 * Scoped to the conversation: `call-guards.ts` decides when one ends and calls
 * {@link FailedCallMemo.reset}.
 */

import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import { isRecord } from "@alexkroman1/aai/utils";
import { isFailedToolResult } from "../_prepare-step.ts";

/** At most this many failed calls are remembered and listed — the most recent. */
export const MAX_REMEMBERED_FAILURES = 8;

/** A listed call's arguments are cut to this many characters. */
const MAX_ARGS_CHARS = 200;

/** A quoted failure is cut to this many characters. */
const MAX_ERROR_CHARS = 200;

/** The refusal's `reason` — open-ended in `ToolRefusalReason`, so no type change. */
export const REPEATED_FAILURE_REASON = "repeated_failure";

type Failure = { name: string; args: string; error: string };

/**
 * See this module's doc. Held by a `ToolCallGuards`, never shared across
 * conversations.
 */
export class FailedCallMemo {
  /** Insertion-ordered, so the oldest is evicted first and the list reads in order. */
  readonly #failures = new Map<string, Failure>();

  /** A refusal to answer the call with instead of running it, or `undefined` to run it. */
  refuse(name: string, args: unknown): string | undefined {
    const prior = this.#failures.get(callKey(name, args));
    if (prior === undefined) return undefined;
    return serializeToolFailure(
      `Not sent: ${name} already failed with exactly these arguments ` +
        `(${prior.error}), and would fail the same way again, so the identical call is ` +
        "refused every time. Change an argument, use a different identifier, or ask the " +
        "user for the correct value.",
      REPEATED_FAILURE_REASON,
    );
  }

  /**
   * Remember the settled call's outcome. Returns the note to append to the
   * MODEL's copy of a failure — every failed call so far — or `undefined`.
   */
  settle(name: string, args: unknown, result: string): string | undefined {
    if (!isFailedToolResult(result)) {
      this.#failures.clear();
      return undefined;
    }
    const key = callKey(name, args);
    // Re-inserted, so a failure seen again moves to the end of the list.
    this.#failures.delete(key);
    this.#failures.set(key, {
      name,
      args: clip(JSON.stringify(canonicalJson(args)) ?? "{}", MAX_ARGS_CHARS),
      error: clip(result.trim(), MAX_ERROR_CHARS),
    });
    while (this.#failures.size > MAX_REMEMBERED_FAILURES) {
      const oldest = this.#failures.keys().next().value;
      if (oldest === undefined) break;
      this.#failures.delete(oldest);
    }
    const tried = [...this.#failures.values()].map((f) => `${f.name}(${f.args})`);
    return `Already tried, all failed: ${tried.join("; ")}`;
  }

  /** A new conversation: nothing remembered applies to it. */
  reset(): void {
    this.#failures.clear();
  }
}

/** `(name, canonical-JSON args)` — key order does not make a call new. */
function callKey(name: string, args: unknown): string {
  return JSON.stringify([name, canonicalJson(args)]);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalJson(value[key]);
  return sorted;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
