// Copyright 2026 the AAI authors. MIT license.
/**
 * `metrics.collected`: what ONE reply cost, stage by stage.
 *
 * Its own module for the reason `protocol-events-accounting.ts` is one:
 * `protocol-events.ts` is at the source-length cap, and this carries more
 * argument than schema. `SessionEventSchema` names it, so it is an ordinary
 * member — same envelope, same retained stream, same `agent({ events })` key.
 *
 * ## Why a frame, when the numbers were already in the log
 *
 * The runtime measured most of this before the event existed — the `LLM turn`
 * and `TTS first audio` log lines — and a log line is readable by exactly one
 * audience: whoever has the server's stdout. An author could not chart their
 * agent's latency, a client could not render it, and an OTel collector could
 * only see it as a span attribute on the model call, with no TTS and no STT.
 * A frame reaches all three through the paths every other event already
 * takes: the client over the socket, the agent's `events` hooks, and the
 * runtime's metrics sinks (`registerMetricsSink` in `@alexkroman1/aai-runtime`,
 * which is what exports OTel histograms).
 *
 * ## Per REPLY, and never per step or per chunk
 *
 * One frame when a reply settles — completed or cut short — so a session pays
 * one retained entry per turn, not one per token or per audio chunk. That is
 * the same budget `usage.updated` argues for, and the reason this is not a
 * stream of per-stage frames: a stage's numbers are only final once its reply
 * is.
 *
 * ## Every stage is OPTIONAL, and absent means "did not happen"
 *
 * A greeting has no STT stage (nobody spoke), a reply the caller talked over
 * may have no TTS stage (nothing was synthesized yet), and a turn a guardrail
 * refused before the model has no LLM stage. Absent rather than zero, for the
 * reason `pipeline-llm-trace.ts` gives: a zero averages in as the fast case,
 * and "the model answered instantly" is a lie a dashboard would believe.
 *
 * ## Which modes emit it
 *
 * PIPELINE mode, where this runtime owns each stage and can time it. An S2S
 * provider runs STT, the model and TTS inside one service and reports none of
 * the boundaries between them, and text mode has no audio stage to time; both
 * are future work rather than frames of zeroes.
 *
 * @module
 */

import { z } from "zod";
import { SessionEventMetaSchema } from "./protocol-event-meta.ts";

/** A duration in whole milliseconds. */
const ms = z.number().int().nonnegative();

/**
 * One reply's per-stage measurements — see this module's header.
 *
 * Every duration is in milliseconds, measured on the runtime's own clock.
 */
export const MetricsCollectedEventSchema = z.object({
  type: z.literal("metrics.collected"),
  meta: SessionEventMetaSchema,
  /**
   * The reply was cut short — a barge-in, a reset, the session ending. Its
   * stages are still reported: an interrupted reply spent what it spent.
   */
  interrupted: z.boolean(),
  /**
   * From the caller's turn being COMMITTED (the transcriber's final) to the
   * first audio of the reply leaving for the caller — the agent's response
   * latency as the runtime can see it. Absent for a reply no caller turn
   * started (a greeting, a silence nudge) and for one that never spoke.
   *
   * Add `stt.endpointingMs` for the latency from the caller's last heard word.
   */
  latencyMs: ms.optional(),
  /** The caller's turn that started this reply. Absent when none did. */
  stt: z
    .object({
      /**
       * From the last partial transcript that carried words to the committed
       * final: how long the transcriber waited before deciding the caller was
       * done: the endpointing half of a turn's latency.
       */
      endpointingMs: ms.optional(),
    })
    .optional(),
  /** The model request(s) behind the reply. Absent when none was made. */
  llm: z
    .object({
      /** Time to the model's first content part — text, reasoning or a tool call. */
      ttftMs: ms.optional(),
      /** From the request going out to the stream settling, tool steps included. */
      durationMs: ms,
      /** Completed model steps — one per request in a tool loop. */
      steps: z.number().int().nonnegative(),
      /**
       * Tokens reported while this reply ran, including any `ctx.generate` /
       * `ctx.delegate` its tools made. Absent when the provider reported none.
       */
      inputTokens: z.number().int().nonnegative().optional(),
      /** As {@link inputTokens}, for generated tokens. */
      outputTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /** Synthesis. Absent when no text reached the TTS provider. */
  tts: z
    .object({
      /** From the reply's first text reaching TTS to its first audio arriving. */
      ttfbMs: ms.optional(),
      /** Characters sent to TTS — the unit most TTS providers bill in. */
      characters: z.number().int().nonnegative(),
    })
    .optional(),
});
