// Copyright 2026 the AAI authors. MIT license.
/**
 * Observability for the ONE-SHOT generations — the `generateText` /
 * `generateObject` calls that are not the pipeline's turn.
 *
 * **The gap this closes is that none of them logged anything at all.** Five
 * sites make a model call outside the turn path, and between them they emitted
 * zero lines: `ctx.generate` (`host/generate.ts`) has no logger in scope, the
 * studio's context compaction wraps its summarizer in a bare `try/catch` that
 * returns the original messages, `studio-tool-repair.ts` ends in
 * `catch { return null; }`, `generate_design_inspiration` catches to a string,
 * and the pipeline's own tool-argument repair warns but times nothing. So an
 * agent author whose `ctx.generate` was failing — a bad key, a rejected model,
 * a gateway 500 — saw a tool that "just returned nothing", with the server log
 * silent and the turn line beside it healthy.
 *
 * It is a telemetry INTEGRATION rather than a wrapper around each call because
 * that is the only shape that can see a failure: `onError` fires for the
 * provider error itself, where a `catch` around the call sees whatever the
 * caller chose to translate it into — usually nothing.
 *
 * **Deliberately debug-level for success and warn for failure.** These run per
 * tool call in some agents; a per-call info line would bury the turn lines
 * that make a server log readable, while a swallowed failure is precisely what
 * this exists to surface.
 *
 * Lives in `sdk/` and is exported from `@alexkroman1/aai/internal` so the guest
 * harness can use it too: `Telemetry` is a TYPE-only import, so this adds no
 * runtime dependency on `ai` and does not drag the runtime barrel — and the
 * harness embeds no runtime by design.
 */

import type { Telemetry } from "ai";

/**
 * The two levels this uses, structurally — so the host's `Logger` and the
 * guest's own console shim both satisfy it without either importing the other.
 */
export type TelemetryLogger = {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
};

/**
 * Telemetry for one-shot generations, tagged with what made the call.
 *
 * `label` is the whole diagnostic value of the success line: "a model call
 * took 4 seconds" is not actionable, "the studio's context compaction took 4
 * seconds" is.
 */
export function oneShotTelemetry(deps: {
  log: TelemetryLogger;
  /** What made this call — `ctx.generate`, `compaction`, `tool-repair`, … */
  label: string;
  /** Session id, when the caller has one. */
  sid?: string | undefined;
}): Telemetry {
  const tag = { generation: deps.label, ...(deps.sid === undefined ? {} : { sid: deps.sid }) };
  return {
    onLanguageModelCallEnd(event) {
      deps.log.debug("one-shot generation", {
        ...tag,
        model: event.modelId,
        responseTimeMs: Math.round(event.performance.responseTimeMs),
        inputTokens: event.usage.inputTokens ?? 0,
        outputTokens: event.usage.outputTokens ?? 0,
        finishReason: event.finishReason,
      });
    },
    onError(error) {
      // The one line that would have existed all along. Every caller of these
      // helpers translates the failure into something bland (null, the
      // original messages, a string), so this is the only place the provider's
      // own complaint is still intact.
      deps.log.warn("one-shot generation failed", {
        ...tag,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}
