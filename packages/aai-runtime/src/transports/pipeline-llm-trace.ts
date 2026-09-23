// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-turn LLM timing, as one log line.
 *
 * **The gap this fills is that a stalled turn was unattributable.** The turn
 * path logged nothing between "the caller's words were committed" and "the
 * first thing the caller could perceive", so a 19-second gap on the wire could
 * equally have been the model thinking, the gateway silently retrying a 5xx,
 * or the harness holding the turn behind something — and the three want
 * completely different fixes. Reconstructing it meant diffing wire timestamps
 * against a benchmark's artifacts by hand, which is how this loop spent an
 * afternoon before the numbers existed.
 *
 * Split into its own module rather than added to `pipeline-llm-stream.ts`
 * because that file sits at 473 of the repo's 500-line cap, and observability
 * is the wrong thing to spend the last 27 lines on.
 *
 * Deliberately ONE line per turn, at info, and no per-part logging: these run
 * on every reply of every session, and a per-delta trace would bury the
 * `Pipeline turn committed` / barge-in lines that make a server log readable.
 * The three marks are the ones that discriminate between the causes above —
 * time to the first stream part (the model started producing), time to the
 * first tool call (it chose to act rather than speak), and total.
 *
 * **It also names the turn's tool calls, and any the turn left UNEXECUTED.** A
 * step that ends on an unsafe finish reason (`length`, `other`, …) carries a
 * tool call the AI SDK refuses to run, and the only trace that used to leave
 * was `firstToolMs === totalMs` and a history that broke every later request
 * (`../tool-call-pairs.ts`). So the line carries `toolCalls`, and a step that
 * finished with a call still unanswered adds `unexecutedToolCalls` plus the
 * step's finish reason — and a warn of its own, since that is a turn the caller
 * heard nothing from.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { Logger } from "../runtime-config.ts";
import type { LlmTiming } from "./pipeline-turn-metrics.ts";

/** The fields of a stream part the trace reads beyond its type. */
export interface TracePart {
  readonly toolCallId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly finishReason?: string | undefined;
  readonly rawFinishReason?: string | undefined;
}

/** Per-turn timing recorder — see {@link createTurnTrace}. */
export interface TurnTrace {
  /**
   * A stream part arrived; the first part the MODEL produced stops the
   * time-to-first-part clock. See {@link isModelPart} for why not every part
   * qualifies.
   */
  onPart(kind: string, part?: TracePart): void;
  /** Emit the turn's one summary line. Idempotent. */
  done(opts: { steps: number; aborted: boolean }): void;
}

/**
 * Does this stream part mean the MODEL produced something?
 *
 * `firstPartMs` exists to answer "did the model start generating, or is the
 * gateway sitting on the request" — and it answered neither while it timed
 * every part, because the AI SDK enqueues `start` and `start-step` from
 * `streamText` synchronously, before the HTTP request has a response. Every
 * turn therefore logged `firstPartMs: 0`-`2` beside a `firstToolMs` of 600-1200,
 * which reads as an instant model and is just the SDK's own bookkeeping. Two
 * benchmark runs' worth of turns were logged that way, so the one number that
 * would have decomposed their latency was absent while appearing present —
 * the failure mode the module doc warns about, in the module itself.
 *
 * Content parts only, then. `error` counts: a stream that fails is a stream
 * that reached the provider, and timing it is the point.
 */
function isModelPart(kind: string): boolean {
  return (
    kind === "text-delta" ||
    kind === "reasoning-delta" ||
    kind === "tool-call" ||
    kind === "tool-input-start" ||
    kind === "error"
  );
}

/**
 * The turn's tool calls, and which of them a FINISHED step left without a
 * result — see the module doc. A call counts as unexecuted only once a
 * `finish-step` follows it unanswered: a run abandoned mid-step (a barge-in,
 * a poisoned adoption) never finished the step, and its call is not one the
 * SDK declined to run.
 */
function createToolLedger(): {
  onPart(kind: string, part: TracePart | undefined): void;
  summary(): Record<string, unknown>;
  unexecuted(): readonly string[];
} {
  const names: string[] = [];
  const pending = new Map<string, string>();
  const unexecuted: string[] = [];
  let finishReason: string | undefined;
  let rawFinishReason: string | undefined;
  return {
    onPart(kind, part) {
      const id = part?.toolCallId ?? "";
      if (kind === "tool-call") {
        names.push(part?.toolName ?? "");
        pending.set(id, part?.toolName ?? "");
      } else if (kind === "tool-result" || kind === "tool-error") {
        pending.delete(id);
      } else if (kind === "finish-step") {
        unexecuted.push(...pending.values());
        pending.clear();
        finishReason = part?.finishReason;
        rawFinishReason = part?.rawFinishReason;
      }
    },
    summary() {
      if (unexecuted.length === 0) return names.length > 0 ? { toolCalls: names } : {};
      return {
        toolCalls: names,
        unexecutedToolCalls: unexecuted,
        ...omitUndefined({ finishReason, rawFinishReason }),
      };
    },
    unexecuted: () => unexecuted,
  };
}

/**
 * Start timing a turn.
 *
 * `adopted` distinguishes a turn that inherited a speculation's already-running
 * request from one that opened its own, because their time-to-first-part means
 * different things and averaging the two hides both.
 */
export function createTurnTrace(deps: {
  log: Logger;
  sid: string;
  adopted: boolean;
  now?: (() => number) | undefined;
  /** The same numbers, for the reply's `metrics.collected` frame. */
  onDone?: ((timing: LlmTiming) => void) | undefined;
}): TurnTrace {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let firstPartMs: number | undefined;
  let firstToolMs: number | undefined;
  // Counted off the stream rather than taken from the caller, whose `steps` is
  // a MESSAGE count (a tool step contributes two).
  let finishedSteps = 0;
  let finished = false;
  const tools = createToolLedger();

  return {
    onPart(kind: string, part?: TracePart): void {
      tools.onPart(kind, part);
      if (kind === "finish-step") finishedSteps++;
      if (!isModelPart(kind)) return;
      firstPartMs ??= now() - startedAt;
      if (kind === "tool-call") firstToolMs ??= now() - startedAt;
    },
    done({ steps, aborted }): void {
      if (finished) return;
      finished = true;
      const totalMs = now() - startedAt;
      deps.onDone?.({ firstPartMs, totalMs, steps: finishedSteps });
      deps.log.info("LLM turn", {
        sid: deps.sid,
        adopted: deps.adopted,
        // Absent rather than 0 when nothing arrived: a turn that produced no
        // part at all (aborted early, or a request that died) is a different
        // animal from one that produced its first part instantly, and a zero
        // would average in as if it were the fast case.
        ...omitUndefined({ firstPartMs, firstToolMs }),
        totalMs,
        steps,
        ...(aborted ? { aborted: true } : {}),
        ...tools.summary(),
      });
      if (tools.unexecuted().length > 0) {
        deps.log.warn("LLM turn ended with unexecuted tool calls", {
          sid: deps.sid,
          ...tools.summary(),
        });
      }
    },
  };
}
