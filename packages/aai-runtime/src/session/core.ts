// Copyright 2026 the AAI authors. MIT license.
/**
 * Unified session — owns reply lifecycle, conversation history, idle timeout,
 * and tool-step enforcement, bridging a Transport to the client protocol.
 *
 * ## Two inbound vocabularies, and the session speaks both by name
 *
 * A session has exactly two things talking to it, and the protocol already names
 * everything either of them can say. So it takes a {@link ServerSession.command} —
 * one `SessionCommand`, what the CLIENT asks for (`commands.ts`) — and a
 * {@link ServerSession.report} — one `TransportEventBody`, what the TRANSPORT
 * observed (`report.ts`). That is the whole inbound surface, plus the two audio
 * paths, which are binary and in neither vocabulary. See `transports/types.ts`
 * for the argument in full.
 *
 * ## One core for every transport
 *
 * Nothing here asks WHICH transport it is driving. Where the transports differ,
 * the session reads the transport's declared `capabilities` — `hostedTurn`
 * decides whether a `tool.called` report is an observation (the host's own
 * model loop ran the tool) or a request (the service is waiting on a result),
 * and every other row is read the same way (`../transports/capabilities.ts`).
 * The runtime's callbacks are a flat forward into `report`.
 */

import type { Message } from "@alexkroman1/aai";
import { DEFAULT_IDLE_TIMEOUT_MS } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { consoleLogger } from "../logger.ts";
import type { ClientToolAnswer } from "../tools/index.ts";
import {
  createRetainedView,
  estimateConversationTokens,
  HISTORY_RETAIN_TOKENS,
} from "../transports/pipeline/index.ts";
import type { TransportEventBody } from "../transports/types.ts";
import { createCommandDispatcher } from "./commands.ts";
// Imported as well as re-exported below: a re-export does not bring the names
// into scope, and `createSessionCore`'s signature needs both. Same trap the
// root guide records for `ToolContext` in `sdk/types.ts`.
import type { ServerSession, ServerSessionOptions } from "./core-types.ts";
import { clientHistoryFrame, historyMessageOf, modelHistoryOf } from "./event-history.ts";
import { stampSessionEvent } from "./event-stream.ts";
import { createIdleWatchdog } from "./idle.ts";
import { createReplyTracker } from "./reply-tracker.ts";
import { createReportDispatcher } from "./report.ts";
import { createSpeechVerbs } from "./speech.ts";

/**
 * Create the server-side session core for one connected client.
 *
 * @internal
 */
export function createSessionCore(opts: ServerSessionOptions): ServerSession {
  const log = opts.logger ?? consoleLogger;
  const rawIdleMs = opts.agentConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  // The current reply and the tool work chained onto it — see `reply-tracker.ts`.
  const replies = createReplyTracker();
  let history: Message[] = [];
  // Bumped by `reset`: a tool call settling into a later conversation than
  // the one it was issued in is dropped — see `ToolStepDeps.conversation`.
  let conversation = 0;
  // A MEMORY bound in tokens, never a message count — see
  // `transports/pipeline/history/retention.ts`. A running total, so a push that
  // evicts nothing does not re-sum the window.
  const retained = createRetainedView(
    () => history,
    HISTORY_RETAIN_TOKENS,
    estimateConversationTokens,
  );
  let stopped = false;
  /** For {@link ServerSession.faultCode} — see there for the log it exists to fix. */
  let faultCode: string | undefined;
  const emit = opts.emitter.emit;

  // The idle deadline and everything it means — see `idle.ts`, which is
  // where the "measure SPEECH, not bytes" argument lives.
  const idle = createIdleWatchdog({
    sid: opts.id,
    idleMs: rawIdleMs,
    logger: log,
    notify: () => emit({ type: "session.timedOut" }),
    close: () => opts.client.close?.("idle timeout"),
  });

  /** Re-arm the idle deadline. Transport-observed conversation only. */
  function resetIdle(): void {
    if (stopped) return;
    idle.reset();
  }

  function pushMessages(...msgs: Message[]): void {
    history.push(...msgs);
    retained.push(msgs);
  }

  /**
   * Append whatever conversation message a reported event contributes —
   * `historyMessageOf` is the one home of that rule (`event-history.ts`).
   */
  function pushConversation(event: TransportEventBody): void {
    const message = historyMessageOf(event);
    if (message) pushMessages(message);
  }

  // The client half of the inbound surface — see `commands.ts`, which
  // owns the five commands and the two that deliberately do less than they look
  // like they should.
  const answerClientTool = (answer: ClientToolAnswer): void =>
    opts.clientTools?.answer(opts.id, answer);
  const handleCommand = createCommandDispatcher({
    sessionId: opts.id,
    emit,
    log,
    transport: opts.transport,
    abortReplyTools: () => replies.abortTools(),
    cancelReply: () => replies.cancel(),
    clearHistory: () => {
      history = [];
      conversation++;
      retained.recount();
    },
    // A relay owns every `tool_result`; otherwise they answer `clientTool` calls.
    ...omitUndefined({ onToolResult: opts.onToolResult ?? answerClientTool }),
  });

  const toolParameters = new Map((opts.toolSchemas ?? []).map((t) => [t.name, t.parameters]));
  // The transport half — see `report.ts`.
  const handleReport = createReportDispatcher({
    sessionId: opts.id,
    emit,
    log,
    isStopped: () => stopped,
    resetIdle,
    replies,
    // Built once: everything here is fixed for the session's lifetime, and
    // `history` is a thunk precisely because the array is not.
    toolStepDeps: {
      sessionId: opts.id,
      agentConfig: opts.agentConfig,
      // The shared per-call core's context (`../tools/run-tool-call.ts`) — the
      // same coercion, snapshot and record the pipeline's tools run with.
      toolCall: {
        executeTool: opts.executeTool,
        sessionId: opts.id,
        messages: () => history,
        parameters: (name: string) => toolParameters.get(name),
        // Straight into the same window the transcripts land in, so a tool reads
        // an earlier tool's result on the next call of the reply — see
        // `ToolStepDeps.toolCall`.
        recordToolResult: (message: Message) => pushMessages(message),
      },
      conversation: () => conversation,
      emit,
      log,
      relayed: Boolean(opts.onToolResult),
    },
    isHostedTurn: () => opts.transport.capabilities.hostedTurn,
    // The `reply.done` dispatcher's view of the session. Thunks, not values:
    // the reply and its turn promise are both reassigned by a barge-in
    // mid-dispatch, and reading them late is that module's staleness handling.
    replyDoneDeps: {
      sessionId: opts.id,
      agent: opts.agent,
      emit,
      log,
      currentReply: () => replies.current(),
      turnPromise: () => replies.turnPromise(),
      sendToolResult: (callId: string, result: string) =>
        opts.transport.sendToolResult(callId, result),
    },
    pushConversation,
    // FIRST one wins: the earliest fatal is the cause, and everything after
    // it is likely downstream of the same failure.
    recordFault: (code) => {
      faultCode ??= code;
    },
  });

  // `say`/`interrupt` for code that is not the model's turn — see
  // `speech.ts`. The interrupt IS the client's cancel.
  const speech = createSpeechVerbs({
    transport: opts.transport,
    stopped: () => stopped,
    cancel: () => handleCommand({ type: "cancel" }),
  });

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
      replies.abortTools();
      const turnPromise = replies.turnPromise();
      if (turnPromise !== null) await turnPromise;
      await opts.transport.stop();
    },

    onAudio(bytes) {
      // Deliberately does NOT re-arm the idle timer — see `resetIdle`.
      opts.transport.sendUserAudio(bytes);
    },
    command: handleCommand,
    say: speech.say,
    interrupt: speech.interrupt,
    announce(instruction) {
      // A stopped session's transport may still hold sockets mid-teardown, so
      // the check is the session's own flag rather than the transport's.
      // The flag decides (`capabilities.test.ts` holds it to the verb); `?.`
      // only narrows the optional member.
      if (stopped || !opts.transport.capabilities.announce) return false;
      log.info("Session announcement", { sid: opts.id });
      opts.transport.injectTurn?.(instruction);
      return true;
    },
    restoreHistory(messages, toolCalls = []) {
      pushMessages(...messages);
      // Forward to the transport so pipeline mode's LLM sees the restored
      // context on resume (S2S restores context service-side via resume). The
      // model's view carries each prior tool call as a real call/result pair
      // rather than losing it, or showing it as text the model then imitates —
      // see `modelHistoryOf`.
      opts.transport.seedHistory?.(messages, modelHistoryOf(messages, toolCalls));
      // And to the CLIENT: everything above restores the conversation for the
      // MODEL, and a reconnecting browser replays nothing of its own — see
      // `history.restored` in `sdk/protocol-events.ts`.
      //
      // Through the SINK with its own stamp, never `emit`: the emitter RECORDS
      // first, so emitting the history just read out of the log would append it
      // back — doubling the log on every resume.
      //
      // The frame carries a DISPLAY window of it (`clientHistoryFrame`), the
      // one bound left in message counts — see `MAX_CLIENT_MESSAGES`.
      const frame = clientHistoryFrame(messages, toolCalls);
      // Sent when there is EITHER to show: a conversation that was only tool
      // calls (a turn that died mid-chain) still has rows to render.
      if ((frame.messages.length > 0 || frame.toolCalls.length > 0) && opts.client.open) {
        opts.client.event(stampSessionEvent({ type: "history.restored", ...frame }));
      }
    },

    // ─── Inbound from transport ───────────────────────────────────────────
    report: handleReport,

    onReplyStarted(replyId) {
      // A turn beginning is progress, and a tool-chaining turn can run for a
      // while before any audio: without this the agent could be reaped
      // mid-work when the dead-air cover is disabled (`silence: { deadAirCoverMs: 0 }`).
      resetIdle();
      // stop() aborts the current reply and then awaits transport.stop() — an
      // async drain during which the transport can still report a trailing
      // reply start. Unguarded, a new reply would mint a fresh, un-aborted
      // controller for post-teardown tool calls to run on.
      if (stopped) return;
      replies.begin(replyId);
    },

    onAudioChunk(bytes) {
      if (stopped) return;
      // The agent is speaking — a long reply must not be reaped mid-sentence.
      resetIdle();
      replies.current().flushedAwaitingContinuation = false;
      opts.client.playAudioChunk(bytes);
    },
  };
}
