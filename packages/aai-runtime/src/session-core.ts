// Copyright 2026 the AAI authors. MIT license.
/**
 * Unified session — owns reply lifecycle, conversation history, idle timeout,
 * and tool-step enforcement, bridging a Transport to the client protocol.
 *
 * ## Two inbound vocabularies, and the session speaks both by name
 *
 * A session has exactly two things talking to it, and the protocol already names
 * everything either of them can say. So it takes a {@link ServerSession.command} —
 * one `SessionCommand`, what the CLIENT asks for — and a {@link ServerSession.report}
 * — one `TransportEventBody`, what the TRANSPORT observed. That is the whole
 * inbound surface, plus the two audio paths, which are binary and in neither
 * vocabulary.
 *
 * It used to be nineteen `on*` methods: five mirroring the five command names,
 * thirteen mirroring the event names, and `onAudio`. `ws-handler.ts` held a switch
 * to pick among the first five and `runtime-session-callbacks.ts` a flat forward
 * for the other thirteen, so every name existed three times over — here, at the
 * transport boundary, and in whichever harness stood in for the thing that fired
 * it. None of that duplication decided anything; see `transports/types.ts` for the
 * argument in full.
 */

import type { Message } from "@alexkroman1/aai";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_HISTORY } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { consoleLogger } from "./runtime-config.ts";
import { createCommandDispatcher } from "./session-commands.ts";
// Imported as well as re-exported below: a re-export does not bring the names
// into scope, and `createSessionCore`'s signature needs both. Same trap the
// root guide records for `ToolContext` in `sdk/types.ts`.
import type { ServerSession, ServerSessionOptions } from "./session-core-types.ts";
import { historyMessageOf } from "./session-event-history.ts";
import { stampSessionEvent } from "./session-event-stream.ts";
import { createIdleWatchdog } from "./session-idle.ts";
import { dispatchReplyDone } from "./session-reply-done.ts";
import { type ReplyToolState, runToolStep } from "./session-tool-steps.ts";
import type { TransportEventBody } from "./transports/types.ts";

/**
 * This session's view of one reply's tool state.
 *
 * The shape is `session-tool-steps.ts`'s — that module mutates it — with the two
 * fields whose meaning belongs to the TURN documented here:
 *
 * - `abort` cancels this reply's in-flight tool executions on
 *   barge-in/reset/stop.
 * - `flushedAwaitingContinuation` is true after a `reply.done` flushed this
 *   reply's tool results to the transport and the turn is waiting on the
 *   provider's continuation. Cleared by any sign of continuation progress (tool
 *   call, transcript, audio). While set, a `reply.done` with no new pending tools
 *   is a duplicate frame — flushing it would emit a premature client
 *   `reply.completed`/`audio.completed` mid-turn.
 */
type ReplyState = ReplyToolState;

export type {
  ServerSession,
  ServerSessionOptions,
} from "./session-core-types.ts";

/**
 * Create the server-side session core for one connected client.
 *
 * @internal
 */
export function createSessionCore(opts: ServerSessionOptions): ServerSession {
  const log = opts.logger ?? consoleLogger;
  const rawIdleMs = opts.agentConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  function emptyReply(): ReplyState {
    return {
      currentReplyId: null,
      pendingTools: [],
      toolCallCount: 0,
      abort: new AbortController(),
      flushedAwaitingContinuation: false,
    };
  }

  let reply: ReplyState = emptyReply();
  let history: Message[] = [];
  let turnPromise: Promise<void> | null = null;
  let stopped = false;
  /** For {@link ServerSession.faultCode} — see there for the log it exists to fix. */
  let faultCode: string | undefined;
  const emit = opts.emitter.emit;

  // The idle deadline and everything it means — see `session-idle.ts`, which is
  // where the "measure SPEECH, not bytes" argument lives.
  const idle = createIdleWatchdog({
    sid: opts.id,
    idleMs: rawIdleMs,
    logger: log,
    notify: () => emit({ type: "session.timed-out" }),
    close: () => opts.client.close?.("idle timeout"),
  });

  // Built once: everything here is fixed for the session's lifetime, and
  // `history` is a thunk precisely because the array is not.
  const toolStepDeps = {
    sessionId: opts.id,
    agentConfig: opts.agentConfig,
    executeTool: opts.executeTool,
    emit,
    log,
    history: () => history,
    relayed: Boolean(opts.onToolResult),
  };

  // The `reply.done` dispatcher's view of the session. Thunks, not values:
  // `reply` and `turnPromise` are both reassigned by a barge-in mid-dispatch, and
  // reading them late is the whole of that module's staleness handling.
  const replyDoneDeps = {
    sessionId: opts.id,
    agent: opts.agent,
    emit,
    log,
    currentReply: () => reply,
    turnPromise: () => turnPromise,
    sendToolResult: (callId: string, result: string) =>
      opts.transport.sendToolResult(callId, result),
  };

  /** Re-arm the idle deadline. Transport-observed conversation only. */
  function resetIdle(): void {
    if (stopped) return;
    idle.reset();
  }

  /**
   * Append whatever conversation message a reported event contributes.
   *
   * `historyMessageOf` rather than a `{ role, content }` per case: this dispatch
   * was the THIRD copy of that rule (`session-event-history.ts` holds the other
   * two, and the argument), and the copy that put a failure phrase into
   * `ctx.messages` on the same call the caller heard it — against the "history /
   * `ctx.messages`: never" its own emitter documents.
   */
  function pushConversation(event: TransportEventBody): void {
    const message = historyMessageOf(event);
    if (message) pushMessages(message);
  }

  function pushMessages(...msgs: Message[]): void {
    history.push(...msgs);
    if (history.length > DEFAULT_MAX_HISTORY) {
      history.splice(0, history.length - DEFAULT_MAX_HISTORY);
    }
  }

  function beginReply(replyId: string): void {
    // Tools still in flight belong to the reply being replaced — they're
    // orphaned either way, so cancel them instead of letting them run on.
    reply.abort.abort();
    reply = { ...emptyReply(), currentReplyId: replyId };
    turnPromise = null;
  }

  function cancelReply(): void {
    reply.abort.abort();
    reply = emptyReply();
  }

  // The client half of the inbound surface — see `session-commands.ts`, which
  // owns the five commands and the two that deliberately do less than they look
  // like they should.
  const handleCommand = createCommandDispatcher({
    sessionId: opts.id,
    emit,
    log,
    transport: opts.transport,
    abortReplyTools: () => reply.abort.abort(),
    cancelReply,
    clearHistory: () => {
      history = [];
    },
    ...omitUndefined({ onToolResult: opts.onToolResult }),
  });

  /** One tool call the transport reported. See {@link ServerSession.report}. */
  function handleToolCalled(event: Extract<TransportEventBody, { type: "tool.called" }>): void {
    resetIdle();
    // See onReplyStarted: a trailing tool.called during stop()'s transport
    // drain must not start tool work (guest RPC, ctx.db, ctx.generate)
    // against a session already torn down.
    if (stopped) return;
    // Bound to the reply that issued the call, by identity — a barge-in or
    // reset swaps in a fresh reply object and the result must land in the
    // orphaned one. See `session-tool-steps.ts`, which owns the budget, the
    // execution, and the `tool.called` emit itself.
    const p = runToolStep(
      reply,
      { callId: event.toolCallId, name: event.toolName, args: event.args },
      toolStepDeps,
    );
    // `!== undefined`, not truthiness: a promise is always truthy, and the
    // absence of one is the signal (the step budget refused the call).
    if (p !== undefined) turnPromise = (turnPromise ?? Promise.resolve()).then(() => p);
  }

  /** One transport report. See {@link ServerSession.report}. */
  function handleReport(event: TransportEventBody): void {
    switch (event.type) {
      case "reply.completed":
        // The PROVIDER's claim, not the turn's end — and so the one report whose
        // name and whose emitted event can come apart. `session-reply-done.ts` is
        // entirely about the three ways a `reply.done` is not the end, and it
        // emits `audio.completed` + `reply.completed` itself when it is.
        dispatchReplyDone(replyDoneDeps);
        return;
      case "reply.cancelled":
        cancelReply();
        break;
      case "tool.called":
        handleToolCalled(event);
        return;
      case "user-transcript.committed":
        resetIdle();
        emit(event);
        pushConversation(event);
        return;
      case "user-transcript.updated":
        // Partials too, not just the committed turn: one long utterance would
        // otherwise only count at its `speech.started`, and could be reaped
        // mid-sentence.
        resetIdle();
        break;
      case "agent-transcript.committed":
        resetIdle();
        reply.flushedAwaitingContinuation = false;
        emit(event);
        // The COMMITTED event only, which is what makes the stream's assistant
        // turns the session's own rather than a re-derivation. An INTERRUPTED
        // reply is reported as `.updated` and enters no history — see the event's
        // own doc, and "History records what was HEARD" in the SDK guide. A
        // committed RECOVERY phrase is the third case and the one this used to
        // get wrong: emitted, because the caller heard it, and never recorded.
        pushConversation(event);
        return;
      case "agent-transcript.updated":
        resetIdle();
        reply.flushedAwaitingContinuation = false;
        break;
      case "speech.started":
        resetIdle();
        break;
      case "error.reported": {
        // This used to emit to the client and nowhere else, so a session killed
        // by an upstream provider — an STT socket hitting a session cap or idle
        // cutoff, a provider deploy — left the server log showing only the
        // subsequent close, with the cause reachable solely by whatever the
        // client chose to do with the frame. `fatal` defaults to true: only an
        // explicit `fatal: false` is non-terminal, and a terminal error is
        // exactly the case that has to be answerable from the server's logs.
        const entry = { sid: opts.id, code: event.code, message: event.message };
        if (event.fatal === false) log.debug("session error", entry);
        else {
          log.warn("session error (fatal)", entry);
          // FIRST one wins: the earliest fatal is the cause, and everything after
          // it is likely downstream of the same failure.
          faultCode ??= event.code;
        }
        break;
      }
      default:
        // `speech.stopped`, `audio.completed`, `tool.completed` — nothing for the
        // session to do but publish them.
        break;
    }
    emit(event);
  }

  return {
    id: opts.id,

    // A getter, not a captured value: the return object is built once at
    // construction, when no error has been reported yet.
    get faultCode() {
      return faultCode;
    },

    configure(config) {
      emit({
        type: "session.configured",
        audioFormat: config.audioFormat,
        sampleRate: config.sampleRate,
        ttsSampleRate: config.ttsSampleRate,
        sessionId: opts.id,
      });
    },

    async start() {
      resetIdle();
      await opts.transport.start();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      idle.clear();
      // Cancel in-flight tools so the drain below settles promptly instead
      // of holding the session (and provider sockets) open for up to the
      // full tool timeout after a disconnect.
      reply.abort.abort();
      if (turnPromise !== null) await turnPromise;
      await opts.transport.stop();
    },

    onAudio(bytes) {
      // Deliberately does NOT re-arm the idle timer — see `resetIdle`.
      opts.transport.sendUserAudio(bytes);
    },
    command: handleCommand,
    announce(instruction) {
      // A stopped session's transport may still hold sockets mid-teardown, so
      // the check is the session's own flag rather than the transport's.
      if (stopped || !opts.transport.injectTurn) return false;
      log.info("Session announcement", { sid: opts.id });
      opts.transport.injectTurn(instruction);
      return true;
    },
    restoreHistory(messages, toolCalls = []) {
      pushMessages(...messages);
      // Forward to the transport so pipeline mode's LLM sees the restored
      // context on resume (S2S restores context service-side via resume).
      opts.transport.seedHistory?.(messages);
      // And to the CLIENT, which is the half that was missing: everything above
      // restores the conversation for the MODEL, and a reconnecting browser
      // stopped replaying its own on the grounds that the server had taken this
      // over. It had not — the transcript came back empty next to an agent that
      // remembered every word, with the greeting suppressed because the resume
      // was genuine. See `history.restored` in `sdk/protocol-events.ts`.
      //
      // Through the SINK with its own stamp, never `emit`: the emitter RECORDS
      // first, so emitting the history just read out of the log would append it
      // back — doubling the log on every resume.
      const visible = messages.filter(
        (m): m is Message & { role: "user" | "assistant" } => m.role !== "tool",
      );
      // Sent when there is EITHER to show: a conversation that was only tool
      // calls (a turn that died mid-chain) still has rows to render.
      if ((visible.length > 0 || toolCalls.length > 0) && opts.client.open) {
        opts.client.event(
          stampSessionEvent({
            type: "history.restored",
            messages: visible.map(({ role, content }) => ({ role, content })),
            toolCalls: [...toolCalls],
          }),
        );
      }
    },

    // ─── Inbound from transport ───────────────────────────────────────────
    report: handleReport,

    onReplyStarted(replyId) {
      // A turn beginning is progress, and a tool-chaining turn can run for a
      // while before any audio: without this the agent could be reaped
      // mid-work when the dead-air cover is disabled (`deadAirCoverMs: 0`).
      resetIdle();
      // stop() aborts the current reply and then awaits transport.stop() — an
      // async drain during which the transport can still report a trailing
      // reply start. Unguarded, beginReply would mint a fresh, un-aborted
      // controller for post-teardown tool calls to run on.
      if (stopped) return;
      beginReply(replyId);
    },

    onAudioChunk(bytes) {
      if (stopped) return;
      // The agent is speaking — a long reply must not be reaped mid-sentence.
      resetIdle();
      reply.flushedAwaitingContinuation = false;
      opts.client.playAudioChunk(bytes);
    },
  };
}
