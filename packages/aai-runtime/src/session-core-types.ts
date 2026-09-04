// Copyright 2026 the AAI authors. MIT license.
/**
 * The server-side session's public shape, split from its implementation.
 *
 * `session-core.ts` sat at the 500-line cap, and the two exported types ahead
 * of `createSessionCore` are 143 of those lines with no behaviour in them.
 * Splitting on that seam is what the file-length gate asks for, and it mirrors
 * `aai-ui/session-core-types.ts`, which made the same cut for the same reason.
 *
 * `session-core.ts` re-exports both names, so every existing import path is
 * unchanged.
 */

import type { Message } from "@alexkroman1/aai";
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import type { AgentConfig } from "@alexkroman1/aai/manifest";
import type {
  ClientSink,
  ReadyConfig,
  RestoredToolCall,
  SessionCommand,
} from "@alexkroman1/aai/protocol";
import type { Logger } from "./runtime-config.ts";
import type { SessionEmitter } from "./session-emitter.ts";
import type { Transport, TransportEventBody } from "./transports/types.ts";

/**
 * Configuration for {@link createSessionCore}.
 *
 * @internal
 */
export type ServerSessionOptions = {
  id: string;
  agent: string;
  client: ClientSink;
  /**
   * The one way this session publishes an event — see `session-emitter.ts`. It
   * records into the retained stream, sends to {@link ServerSessionOptions.client},
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
 * aai-ui's browser-side `BrowserSession`.
 *
 * @public
 */
export type ServerSession = {
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
   * Sent at zero RTT, before {@link ServerSession.start}, and that ordering is
   * load-bearing: a socket open for seconds carrying nothing is a wedged peer,
   * not a slow one, and aai-ui's handshake guard is armed on exactly this frame.
   */
  configure(config: ReadyConfig): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * The code of the first FATAL error this session reported, if it reported one.
   *
   * Exists so a caller cannot claim a session is fine when it is not.
   * `ws-handler.ts` logs `Session ready` once `start()` resolves, and that is a
   * different question: a provider which cannot open at all reports a fatal error
   * and lets the transport start anyway. Production logged
   * `session error (fatal) { code: 'tts', message: 'AssemblyAI TTS: missing API
   * key…' }` and `Session ready` 400ms later, in that order — a session that could
   * never speak, announced as ready.
   *
   * Deliberately NOT a reason to stop the session. `fatal` defaults to true, so it
   * covers a wide class here (see the `error.reported` case), and the transport
   * owns whether a session ends; this is an observation, not a policy.
   */
  readonly faultCode: string | undefined;
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
