// Copyright 2026 the AAI authors. MIT license.
/**
 * One reply's per-stage measurements, assembled into the `metrics.collected`
 * frame the transport reports when the reply settles.
 *
 * ## The marks were already being taken, for a log line
 *
 * `pipeline-llm-trace.ts` timed the model and `pipeline-audio-out.ts` timed the
 * first audio, and both wrote the number to the server log and nowhere else.
 * This module is where those marks now also LAND: each producer hands its
 * number here, and the reply scaffold turns what arrived into one frame. The
 * log lines stay — they are what an operator greps — but they are no longer
 * the only reader.
 *
 * ## Per-reply state is opened by `begin` and closed by `finish`
 *
 * The transport serializes replies (one turn chain, one in flight), so there is
 * at most one open reply and a mark has no reply id to carry: it belongs to
 * whichever reply is open. A mark that arrives with none open — a TTS frame
 * from a reply already settled — is dropped rather than credited to the next.
 *
 * The STT marks are the exception, because they happen BEFORE the reply they
 * start: the caller's utterance is heard, committed, and only then does a
 * reply begin — possibly several replies later, since a turn committed while
 * the agent is still speaking waits on the turn chain. So each committed turn
 * is QUEUED under its own text and CLAIMED by the turn body answering exactly
 * that text (`claimTurn`). Keyed rather than "whatever is pending", because the
 * next reply to start is not always the one a final belongs to: two finals
 * queued behind a speaking agent would otherwise hand the first turn the
 * second's timing, and a turn dropped by a reset would lend its timing to the
 * next silence nudge. A greeting, a nudge or an injected prompt answers no
 * final's text, so it claims nothing.
 *
 * Deliberately no timers and no async: every method is a clock read and an
 * assignment, on paths (each partial, each audio chunk) that run many times a
 * second.
 */

import type { MetricsCollectedEvent } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { SttTurnMeta } from "../providers/openers.ts";
import type { UsageMeter } from "../usage-meter.ts";

/** The frame this module builds, as the transport reports it. */
export type MetricsCollectedBody = Omit<MetricsCollectedEvent, "meta">;

/** What the LLM trace hands over when a pass settles. */
export interface LlmTiming {
  /** Absent when the model produced no content part. */
  firstPartMs?: number | undefined;
  totalMs: number;
  steps: number;
}

/** The recorder — see this module's header. */
export interface TurnMetrics {
  /** A partial transcript carrying words arrived. */
  onPartial(): void;
  /** The caller's turn was committed, with the text the turn will answer. */
  onFinal(text: string): void;
  /**
   * The caller's utterance closed — committed, gone quiet with no final, or
   * reset. A partial before this is not part of the next utterance.
   */
  onUtteranceEnded(): void;
  /** A reply took the floor. */
  begin(): void;
  /** The open reply answers the committed turn `text`: attach its STT marks. */
  claimTurn(text: string): void;
  /** One LLM pass settled. A restarted pass overwrites the abandoned one. */
  onLlm(timing: LlmTiming): void;
  /** Text went to TTS. */
  onTtsText(text: string): void;
  /** The first audio of this reply was delivered toward the caller. */
  onFirstAudio(afterTextMs: number): void;
  /** The reply settled: the frame, or `undefined` when none was open. */
  finish(interrupted: boolean): MetricsCollectedBody | undefined;
}

type OpenReply = {
  committedAt?: number | undefined;
  endpointingMs?: number | undefined;
  tokensAtStart?: Tokens | undefined;
  llm?: LlmTiming | undefined;
  ttsChars: number;
  ttfbMs?: number | undefined;
  firstAudioAt?: number | undefined;
};

const whole = (n: number): number => Math.max(0, Math.round(n));

type Tokens = { input: number; output: number };

type CommittedTurn = { text: string; committedAt: number; endpointingMs?: number | undefined };

/** Committed turns held for a claim — far more than a turn chain ever queues. */
const MAX_PENDING_TURNS = 8;

/**
 * The LLM stage. Tokens are the meter's DELTA across the reply, so a tool's
 * `ctx.generate` inside it is counted, and absent when there is no meter.
 */
function llmStage(
  llm: LlmTiming,
  start: Tokens | undefined,
  end: Tokens | undefined,
): NonNullable<MetricsCollectedBody["llm"]> {
  return {
    ...omitUndefined({
      ttftMs: llm.firstPartMs === undefined ? undefined : whole(llm.firstPartMs),
    }),
    durationMs: whole(llm.totalMs),
    steps: llm.steps,
    ...(start && end
      ? { inputTokens: end.input - start.input, outputTokens: end.output - start.output }
      : {}),
  };
}

/** Build the recorder for one session. */
export function createTurnMetrics(
  deps: { usage?: UsageMeter | undefined; now?: (() => number) | undefined } = {},
): TurnMetrics {
  const now = deps.now ?? Date.now;
  // Session-side: the utterance in progress, and the turns committed from
  // utterances that no reply has claimed yet, oldest first.
  let lastPartialAt: number | undefined;
  const pending: CommittedTurn[] = [];
  let open: OpenReply | undefined;

  const tokens = (): Tokens | undefined => {
    const s = deps.usage?.snapshot();
    return s === undefined ? undefined : { input: s.inputTokens, output: s.outputTokens };
  };

  return {
    onPartial() {
      lastPartialAt = now();
    },
    onFinal(text) {
      const at = now();
      pending.push({
        text,
        committedAt: at,
        endpointingMs: lastPartialAt === undefined ? undefined : whole(at - lastPartialAt),
      });
      // Bounded: an entry no reply ever claims (a turn a reset dropped) must
      // not accumulate for the life of the call.
      if (pending.length > MAX_PENDING_TURNS) pending.shift();
      lastPartialAt = undefined;
    },
    onUtteranceEnded() {
      lastPartialAt = undefined;
    },
    begin() {
      open = { tokensAtStart: tokens(), ttsChars: 0 };
    },
    claimTurn(text) {
      const at = pending.findIndex((turn) => turn.text === text);
      if (!open || at < 0) return;
      // Everything queued BEFORE the match belongs to a turn that was skipped
      // (reset, superseded) and will never be answered.
      const [turn] = pending.splice(0, at + 1).slice(-1);
      open.committedAt = turn?.committedAt;
      open.endpointingMs = turn?.endpointingMs;
    },
    onLlm(timing) {
      if (open) open.llm = timing;
    },
    onTtsText(text) {
      if (open) open.ttsChars += text.length;
    },
    onFirstAudio(afterTextMs) {
      if (!open || open.firstAudioAt !== undefined) return;
      open.firstAudioAt = now();
      open.ttfbMs = whole(afterTextMs);
    },
    finish(interrupted) {
      const reply = open;
      open = undefined;
      if (!reply) return;
      const body: MetricsCollectedBody = { type: "metrics.collected", interrupted };
      if (reply.committedAt !== undefined) {
        body.stt = omitUndefined({ endpointingMs: reply.endpointingMs });
        if (reply.firstAudioAt !== undefined) {
          body.latencyMs = whole(reply.firstAudioAt - reply.committedAt);
        }
      }
      if (reply.llm) body.llm = llmStage(reply.llm, reply.tokensAtStart, tokens());
      if (reply.ttsChars > 0) {
        body.tts = { ...omitUndefined({ ttfbMs: reply.ttfbMs }), characters: reply.ttsChars };
      }
      return body;
    },
  };
}

/** The two STT handlers, in the shape `pipeline-providers.ts` takes them. */
type SttHandlers = {
  onSttPartial(text: string, meta?: SttTurnMeta): void;
  onSttFinal(text: string, meta?: SttTurnMeta): void;
};

/**
 * Take the STT marks BEFORE the ordinary handlers run, since those may start
 * the very reply the marks time. A blank transcript is no mark: it carries no
 * word the caller said.
 */
export function withSttMarks(metrics: TurnMetrics, handlers: SttHandlers): SttHandlers {
  return {
    onSttPartial(text, meta) {
      if (text.trim()) metrics.onPartial();
      handlers.onSttPartial(text, meta);
    },
    onSttFinal(text, meta) {
      const trimmed = text.trim();
      // The same trim the handler commits with, so the claim matches it.
      if (trimmed) metrics.onFinal(trimmed);
      handlers.onSttFinal(text, meta);
    },
  };
}
