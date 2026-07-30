// Copyright 2026 the AAI authors. MIT license.
/**
 * Eve turn runner — sources pipeline replies from a Vercel eve agent session.
 *
 * This is the bridge in the "move to eve, keep the voice paths" migration:
 * the pipeline transport keeps every voice-oriented behavior (STT
 * endpointing, barge-in, TTS coalescing/flush, hold phrase, dead-air cover,
 * false-interruption recovery) and this runner replaces only the reply
 * source — instead of running `streamText` itself, each committed user turn
 * is sent into an eve agent (`run()` for the first turn, `deliver()` after)
 * and the reply is read back off eve's durable session event stream:
 *
 * - `message.appended`   → `text-delta` (assistant token deltas → TTS)
 * - `message.completed`  → `text-end`   (segment boundary)
 * - `actions.requested`  → `tool-call`  (observability; eve executes tools)
 * - `action.result`      → `tool-result`
 * - `turn.failed` / `session.failed` → `error` (transport speaks recovery)
 * - `session.waiting`    → turn over; carries the next continuation token
 *
 * Barge-in maps to `cancelTurn`: when the transport aborts the turn, the
 * runner requests cancellation and stops reading. Events of the cancelled
 * turn that were never read stay in the stream; the next turn's read skips
 * them via the turn gate below (content is ignored until that turn's own
 * `turn.started` arrives).
 *
 * The eve dependency is *structural*: {@link EveAgentHandle} mirrors the
 * `Agent` handle eve passes to channel routes (eve 0.28), so this module
 * needs no import from `eve` — the channel package hands the real handle in.
 * Event `data` is read tolerantly (unknown fields ignored, missing fields
 * degrade to no-ops) so a minor eve protocol addition doesn't break voice.
 */

import { errorMessage } from "../../sdk/utils.ts";
import type { LlmStreamResult } from "./pipeline-stream.ts";
import { createTtsTextCoalescer } from "./pipeline-stream.ts";
import { createStreamPartHandler, type StreamPartHandler } from "./pipeline-stream-parts.ts";
import type { PipelineTurnArgs, PipelineTurnRunner } from "./pipeline-turn-runner.ts";

/** One event read from an eve session stream (structural, tolerant). */
export interface EveStreamEvent {
  readonly type: string;
  readonly data?: Record<string, unknown> | undefined;
}

/**
 * The route-facing eve agent handle (structurally `Agent` from
 * `eve/channels`, eve 0.28). The voice channel passes `ctx.agent` through.
 */
export interface EveAgentHandle {
  run(input: Record<string, unknown>): Promise<{ sessionId: string }>;
  deliver(input: {
    continuationToken: string;
    payload: Record<string, unknown>;
  }): Promise<{ sessionId: string }>;
  cancelTurn(input: { sessionId: string; turnId?: string }): Promise<unknown>;
  getEventStream(
    sessionId: string,
    options?: { startIndex?: number },
  ): Promise<ReadableStream<EveStreamEvent>>;
}

/** Options for {@link createEveTurnRunner}. */
export interface EveTurnRunnerOptions {
  /** The eve agent handle (`ctx.agent` inside a channel route). */
  agent: EveAgentHandle;
  /**
   * Extra fields merged into the first turn's `run()` input — the channel
   * supplies eve-required fields the runner is deliberately agnostic about
   * (`adapter`, `auth`, `channelName`, ...). `mode` defaults to
   * `"conversation"`; `input` and `continuationToken` are runner-owned.
   */
  runInput?: Record<string, unknown> | undefined;
  /** Session identity for eve delivery. Defaults to `voice:<sid>`. */
  continuationToken?: string | undefined;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Per-turn translation of eve stream events into stream parts. */
type TurnEventHandler = {
  /** Returns true when the event ends this turn's read loop. */
  handle(event: EveStreamEvent): boolean;
  failed(): boolean;
  turnId(): string | null;
};

/**
 * Build the per-turn event translator. `active` is the turn gate: content
 * events are ignored until THIS turn's `turn.started` arrives, so unread
 * leftovers of a cancelled previous turn (see module doc) can never speak
 * into the new turn.
 */
function createTurnEventHandler(
  handler: StreamPartHandler,
  onContinuationToken: (token: string) => void,
): TurnEventHandler {
  let active = false;
  let failed = false;
  let turnId: string | null = null;

  function handleActionsRequested(data: Record<string, unknown>): void {
    const actions = Array.isArray(data.actions) ? data.actions : [];
    for (const action of actions) {
      const a = (action ?? {}) as Record<string, unknown>;
      handler.handle({
        type: "tool-call",
        toolCallId: str(a.callId),
        toolName: str(a.toolName) || str(a.kind),
        input: a.input,
      });
    }
  }

  function handleActionResult(data: Record<string, unknown>): void {
    const result = (data.result ?? {}) as Record<string, unknown>;
    handler.handle({
      type: "tool-result",
      toolCallId: str(result.callId) || str(data.callId),
      output: result.output ?? result,
    });
  }

  /**
   * `session.failed` is session-level: terminal and reported even when the
   * turn gate is closed — the session is dead either way. A stale
   * `turn.failed` (a cancelled previous turn's tail) is skipped. An active
   * `turn.failed` is terminal directly: a failed turn is not guaranteed to
   * park, and waiting on a live stream for a `session.waiting` that never
   * comes would hang the turn.
   */
  function handleFailure(event: EveStreamEvent, data: Record<string, unknown>): boolean {
    if (!(active || event.type === "session.failed")) return false;
    failed = true;
    handler.handle({ type: "error", error: new Error(str(data.message) || `eve ${event.type}`) });
    return true;
  }

  /** Reply-content events, forwarded only while the turn gate is open. */
  function handleContent(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case "message.appended":
        handler.handle({ type: "text-delta", text: str(data.messageDelta) });
        return;
      case "message.completed":
        handler.handle({ type: "text-end" });
        return;
      case "actions.requested":
        handleActionsRequested(data);
        return;
      default:
        handleActionResult(data);
        return;
    }
  }

  function handle(event: EveStreamEvent): boolean {
    const data = event.data ?? {};
    switch (event.type) {
      case "turn.started":
        active = true;
        turnId = str(data.turnId) || null;
        return false;
      case "message.appended":
      case "message.completed":
      case "actions.requested":
      case "action.result":
        if (active) handleContent(event.type, data);
        return false;
      case "turn.failed":
      case "session.failed":
        return handleFailure(event, data);
      case "session.waiting":
        // Eve parked the session; adopt the resume token it minted. Only
        // terminal once THIS turn has started — a stale one (the tail of a
        // cancelled previous turn) must not end the new turn's read.
        onContinuationToken(str(data.continuationToken));
        return active;
      case "session.completed":
        return true;
      default:
        // Includes turn.completed / turn.cancelled: reply markers, not park
        // signals — the token-bearing session.waiting follows both (docs
        // guarantee it), and a stale one must not end the new turn's read.
        return false;
    }
  }

  return { handle, failed: () => failed, turnId: () => turnId };
}

/**
 * Create a {@link PipelineTurnRunner} that drives an eve agent session.
 *
 * One runner instance per voice session: it holds the eve session identity
 * (sessionId, continuation token, event-stream cursor) across turns.
 */
export function createEveTurnRunner(opts: EveTurnRunnerOptions): PipelineTurnRunner {
  const { agent } = opts;
  let sessionId: string | null = null;
  let continuationToken = opts.continuationToken ?? null;
  // Index of the next unread event in the session stream. Advances only for
  // events actually read, so events of a cancelled turn are re-read (and
  // skipped by the turn gate) on the next turn instead of being lost.
  let cursor = 0;

  async function startOrDeliver(args: PipelineTurnArgs): Promise<string> {
    if (sessionId !== null && continuationToken !== null) {
      try {
        const { sessionId: sid } = await agent.deliver({
          continuationToken,
          payload: { message: args.userText },
        });
        return sid;
      } catch (err) {
        // No parked session (expired, restarted) — eve's documented fallback
        // is a fresh run(). The new session starts a new event stream.
        args.log.warn("eve deliver failed; starting a new session", {
          error: errorMessage(err),
          sid: args.sid,
        });
        sessionId = null;
        cursor = 0;
      }
    }
    continuationToken ??= `voice:${args.sid}`;
    const { sessionId: sid } = await agent.run({
      mode: "conversation",
      ...(opts.runInput ?? {}),
      input: { message: args.userText },
      continuationToken,
    });
    return sid;
  }

  /** Read the session stream until the turn ends, advancing the cursor. */
  async function readTurn(args: PipelineTurnArgs, events: TurnEventHandler): Promise<void> {
    const { ctl, log, sid } = args;
    if (sessionId === null) return;
    const stream = await agent.getEventStream(sessionId, { startIndex: cursor });
    const reader = stream.getReader();
    // Barge-in: ask eve to stop the turn and unblock the pending read.
    // cancelTurn without a turnId targets the session's current turn —
    // right for an abort that lands before this turn's `turn.started`.
    const onAbort = (): void => {
      const turnId = events.turnId();
      if (sessionId !== null) {
        agent
          .cancelTurn({ sessionId, ...(turnId !== null ? { turnId } : {}) })
          .catch((err: unknown) =>
            log.debug("eve cancelTurn failed", { error: errorMessage(err), sid }),
          );
      }
      reader.cancel().catch(() => undefined);
    };
    ctl.signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || ctl.signal.aborted) break;
        cursor += 1;
        if (events.handle(value)) break;
      }
    } finally {
      ctl.signal.removeEventListener("abort", onAbort);
      reader.cancel().catch(() => undefined);
    }
  }

  return async function runEveTurn(args: PipelineTurnArgs): Promise<LlmStreamResult> {
    const { ctl, log, sid } = args;
    if (ctl.signal.aborted) return { messages: [], failed: false };

    // Batch word-granularity deltas into fewer TTS sends (streamText parity).
    const ttsText = createTtsTextCoalescer(args.sendTtsText);
    const handler = createStreamPartHandler({
      onDelta: args.onDelta,
      sendTtsText: ttsText.send,
      onTtsBoundary: ttsText.boundary,
      holdPhrase: args.holdPhrase,
      signal: ctl.signal,
      onToolCall: args.callbacks.onToolCall,
      onToolCallDone: args.callbacks.onToolCallDone,
      emitError: args.emitError,
      log,
      sid,
    });
    const events = createTurnEventHandler(handler, (token) => {
      continuationToken = token || continuationToken;
    });

    try {
      sessionId = await startOrDeliver(args);
      await readTurn(args, events);
      if (!ctl.signal.aborted) ttsText.flush();
      // Eve owns the durable conversation history (that is the point of the
      // migration), so no ModelMessages are returned for the local LLM view.
      return { messages: [], failed: events.failed() };
    } catch (err) {
      if (ctl.signal.aborted) return { messages: [], failed: false };
      ttsText.flush();
      const msg = errorMessage(err);
      log.error("eve turn failed", { error: msg, sid });
      args.emitError("llm", msg);
      return { messages: [], failed: true };
    } finally {
      handler.dispose();
    }
  };
}
