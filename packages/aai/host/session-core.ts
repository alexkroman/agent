// Copyright 2026 the AAI authors. MIT license.
/**
 * Unified session — owns reply lifecycle, conversation history, idle timeout,
 * and tool-step enforcement, bridging a Transport to the client protocol.
 *
 * ## Two inbound vocabularies, and the session speaks both by name
 *
 * A session has exactly two things talking to it, and the protocol already names
 * everything either of them can say. So it takes a {@link SessionCore.command} —
 * one `SessionCommand`, what the CLIENT asks for — and a {@link SessionCore.report}
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

import type { AgentConfig, ExecuteTool } from "../sdk/_internal-types.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_HISTORY } from "../sdk/constants.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { ClientSink, ReadyConfig, RestoredToolCall, SessionCommand } from "../sdk/protocol.ts";
import type { Message } from "../sdk/types.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import { createCommandDispatcher } from "./session-commands.ts";
import type { SessionEmitter } from "./session-emitter.ts";
import { stampSessionEvent } from "./session-event-stream.ts";
import { createIdleWatchdog } from "./session-idle.ts";
import { dispatchReplyDone } from "./session-reply-done.ts";
import { type ReplyToolState, runToolStep } from "./session-tool-steps.ts";
import type { Transport, TransportEventBody } from "./transports/types.ts";

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

/**
 * Configuration for {@link createSessionCore}.
 *
 * @internal
 */
export type SessionCoreOptions = {
  id: string;
  agent: string;
  client: ClientSink;
  /**
   * The one way this session publishes an event — see `session-emitter.ts`. It
   * records into the retained stream, sends to {@link SessionCoreOptions.client},
   * and runs the agent's hooks, in that order. `client` is still here for the
   * audio path, which is binary and deliberately outside the event vocabulary.
   */
  emitter: SessionEmitter;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  transport: Transport;
  logger?: Logger;
  /**
   * Host/relay mode hook. When set, tool calls are relayed to the client for
   * out-of-process execution: the `tool.called` report skips its own emit (the
   * relay `executeTool` emits it, keyed by `toolCallId`) and inbound
   * `tool_result` commands are routed here to settle the pending call.
   *
   * Not an observer, which is why it keeps a name: the caller must ACT on it —
   * it is the only thing that settles a pending relay call, and an observe-only
   * hook could not.
   */
  onToolResult?: (msg: { toolCallId: string; result: string; error?: string }) => void;
};

/**
 * One live server-side session: the runtime's bridge between a transport
 * (S2S, pipeline, or OpenAI Realtime) and the connected client. Distinct from
 * aai-ui's browser-side `SessionCore`.
 *
 * @internal
 */
export type SessionCore = {
  readonly id: string;
  /**
   * Announce the session to its client: the handshake frame, carrying the audio
   * negotiation and this session's own id.
   *
   * On the session rather than on the socket handler because it is an EVENT now
   * — `session.configured` — so it is stamped, recorded in the retained stream
   * and seen by hooks like anything else. It used to be a hand-assembled JSON
   * literal written straight to the socket, which is precisely what made the
   * handshake a frame no event log could contain.
   *
   * Sent at zero RTT, before {@link SessionCore.start}, and that ordering is
   * load-bearing: a socket open for seconds carrying nothing is a wedged peer,
   * not a slow one, and aai-ui's handshake guard is armed on exactly this frame.
   */
  configure(config: ReadyConfig): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * One client COMMAND, in the protocol's own command vocabulary
   * (`sdk/protocol-commands.ts`).
   *
   * `ws-handler.ts` parses the frame and hands the whole thing over, rather than
   * switching on `type` to pick one of five methods named after the five
   * commands. An unrecognised type is a no-op here for the same
   * forward-compatibility reason `lenientParse` tolerates one.
   */
  command(cmd: SessionCommand): void;
  /** Binary user audio from the client. Not a command — see the module doc. */
  onAudio(bytes: Uint8Array): void;
  /**
   * Make the agent SPEAK about something the caller did not just say.
   *
   * The instruction reaches the model as a synthetic user message and the reply
   * is an ordinary, interruptible turn. What it exists for is the shape a voice
   * agent otherwise cannot do: a durable run started minutes ago finishes, the
   * caller is still on the line, and the agent has the answer with no way to
   * offer it — so the caller has to think to ask.
   *
   * Reports FALSE rather than throwing when the transport has no such verb
   * (S2S has none) or the session is stopped, because the caller is a run
   * completing in the background: there is nobody to raise to, and the answer
   * "this session cannot be spoken to" is what a notifier needs to stop trying.
   */
  announce(instruction: string): boolean;
  /**
   * Put a prior conversation back, on resume.
   *
   * **The SERVER calls this, from its own retained event stream** — see
   * `runtime-session-stream.ts`. It used to be driven by a `history` client
   * frame, i.e. the client was the authority on what the agent remembered, which
   * is what the event stream exists to replace: a client could omit, truncate or
   * invent turns, and a client that had never connected before (a second tab, a
   * phone call resuming) had nothing to send at all.
   *
   * Restores BOTH views, because they are two lists: `ctx.messages`, which is
   * this module's, and the transport's own LLM history, which is
   * `seedHistory`'s.
   */
  /**
   * Put a resumed session's conversation back — into the model's context, and
   * onto the WIRE for the client.
   *
   * `toolCalls` is the client's half only: the LLM history in the event log is
   * transcripts (see `session-event-history.ts`), so nothing here reaches the
   * model. Defaulted, because a caller that has only messages is a legitimate
   * one — the platform's own `attachSessionStream` passes both.
   */
  restoreHistory(messages: readonly Message[], toolCalls?: readonly RestoredToolCall[]): void;
  /**
   * One thing the TRANSPORT observed, in the protocol's own event vocabulary
   * (`sdk/protocol-events.ts`, narrowed by `TransportEventBody`).
   *
   * Most reports are emitted straight through; what the session adds on top is
   * its own bookkeeping — re-arming the idle deadline, pushing a committed turn
   * into history, swapping the reply object on a cancel, running a tool step.
   * Two never reach the client as themselves: `tool.called`, which S2S mode
   * EXECUTES (`session-tool-steps.ts` emits it), and `reply.completed`, which is
   * the provider's claim rather than the turn's end (`session-reply-done.ts`).
   */
  report(event: TransportEventBody): void;
  /** A reply is beginning. Not an event: the wire has no `reply.started`. */
  onReplyStarted(replyId: string): void;
  /** Binary agent audio from the transport. Not an event — see the module doc. */
  onAudioChunk(bytes: Uint8Array): void;
};

/**
 * Create the server-side session core for one connected client.
 *
 * @internal
 */
export function createSessionCore(opts: SessionCoreOptions): SessionCore {
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

  /** One tool call the transport reported. See {@link SessionCore.report}. */
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

  /** One transport report. See {@link SessionCore.report}. */
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
        pushMessages({ role: "user", content: event.text });
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
        // own doc, and "History records what was HEARD" in the SDK guide.
        pushMessages({ role: "assistant", content: event.text });
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
        else log.warn("session error (fatal)", entry);
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
