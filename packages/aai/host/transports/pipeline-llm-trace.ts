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
 * ## The numbers come from the AI SDK, not from counting stream parts
 *
 * This module used to time the turn by watching `fullStream` go past, which
 * meant maintaining an allow-list of "parts the MODEL produced" — because
 * `streamText` enqueues `start` and `start-step` SYNCHRONOUSLY, before the
 * HTTP request has a response. Every turn logged `firstPartMs: 0`-`2` beside a
 * `firstToolMs` of 600-1200, which reads as an instant model and is just the
 * SDK's own bookkeeping. Two benchmark runs' worth of turns were logged that
 * way, so the one number that would have decomposed their latency was absent
 * while appearing present.
 *
 * `ai@7`'s telemetry integrations report it directly and correctly:
 * `onLanguageModelCallEnd` is scoped to the provider call alone, and its
 * `performance.timeToFirstOutputMs` is measured where only the SDK can measure
 * it. That deletes the allow-list, deletes the per-part callback and the
 * `trace` parameter it was threaded through, and adds token accounting the
 * hand-rolled version could not see at all.
 *
 * **One difference worth knowing rather than papering over**: `firstToolMs` is
 * now stamped when the model call CONTAINING the first tool call ends, where
 * it used to be stamped when the `tool-call` part arrived. It is a slightly
 * later — and better defined — instant, and it still answers the question the
 * field exists for ("did the model choose to act rather than speak, and how
 * long did deciding take"). Do not compare it across that change.
 *
 * Deliberately ONE line per turn, at info, and no per-call logging: these run
 * on every reply of every session, and a line per step would bury the
 * `Pipeline turn committed` / barge-in lines that make a server log readable.
 */

import type { Telemetry } from "ai";
import type { Logger } from "./../runtime-config.ts";

/** Per-turn timing recorder — see {@link createTurnTrace}. */
export interface TurnTrace {
  /**
   * The telemetry integration to hand `streamText`. Per CALL rather than
   * registered globally (`registerTelemetry`), because these numbers belong to
   * one turn of one session and a process-wide integration would have to
   * correlate them back.
   */
  telemetry: Telemetry;
  /**
   * Emit the turn's one summary line. Idempotent.
   *
   * `adopted` distinguishes a turn that inherited a speculation's
   * already-running request from one that opened its own: their
   * time-to-first-output means different things and averaging the two hides
   * both.
   */
  done(opts: { adopted: boolean; aborted: boolean }): void;
}

/** Start timing a turn. */
export function createTurnTrace(deps: {
  log: Logger;
  sid: string;
  now?: (() => number) | undefined;
}): TurnTrace {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let firstOutputMs: number | undefined;
  let firstToolMs: number | undefined;
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let finished = false;

  return {
    telemetry: {
      onLanguageModelCallEnd(event) {
        calls += 1;
        // From the FIRST call only: on a multi-step turn the later ones are
        // separated by tool execution, and "how long until the model started
        // producing" is a question about the first request.
        firstOutputMs ??= event.performance.timeToFirstOutputMs;
        inputTokens += event.usage.inputTokens ?? 0;
        outputTokens += event.usage.outputTokens ?? 0;
        if (firstToolMs === undefined && event.content.some((part) => part.type === "tool-call")) {
          firstToolMs = now() - startedAt;
        }
      },
    },

    done({ adopted, aborted }): void {
      if (finished) return;
      finished = true;
      deps.log.info("LLM turn", {
        sid: deps.sid,
        adopted,
        // Absent rather than 0 when nothing arrived: a turn that produced no
        // output at all (aborted early, or a request that died) is a different
        // animal from one that produced its first token instantly, and a zero
        // would average in as if it were the fast case.
        ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
        ...(firstToolMs === undefined ? {} : { firstToolMs }),
        totalMs: now() - startedAt,
        steps: calls,
        ...(inputTokens || outputTokens ? { inputTokens, outputTokens } : {}),
        ...(aborted ? { aborted: true } : {}),
      });
    },
  };
}
