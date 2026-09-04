// Copyright 2026 the AAI authors. MIT license.
/**
 * The system under test for the S2S property test: one real `ServerSession` over
 * a real `createS2sTransport` over a real `connectS2s`, with the fake link
 * (`_s2s-fuzz-model.ts`) as its socket and a recording `ClientSink` at the far
 * end.
 *
 * Two things live here rather than in the spec:
 *
 * - **The STREAMING oracles**, i.e. the ones that can only fire at the moment an
 *   event reaches the client (nothing after `stop()`, nothing conversational
 *   after a fatal error, no audio for a cancelled reply). They throw, so
 *   fast-check shrinks to the shortest command sequence that reproduces them.
 *   The end-of-run oracles stay in the spec, next to the property.
 * - **Tool settlement is a DEFERRED, resolved by a command** — never a timer.
 *   When a tool settles relative to a socket drop is the whole subject of the
 *   tool-answer oracle, so it has to be part of the generated plan rather than a
 *   race against `setTimeout`.
 *
 * @internal Test infrastructure, not part of any public API.
 */

import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import { invariant } from "@alexkroman1/aai/internal";
import type { AgentConfig, ToolSchema } from "@alexkroman1/aai/manifest";
import type { ClientSink, SessionEvent } from "@alexkroman1/aai/protocol";
import { silentLogger } from "../runtime-config.ts";
import { createSessionCore, type ServerSession } from "../session-core.ts";
import { createSessionEmitter } from "../session-emitter.ts";
import { createSessionEventStream } from "../session-event-stream.ts";
import { createMemoryStateBackend } from "../session-state-store.ts";
import { createS2sTransport } from "../transports/s2s-transport.ts";
import type { TransportCallbacks } from "../transports/types.ts";
import { createFakeS2sLink, type FakeS2sLink } from "./_s2s-fuzz-model.ts";

/** Idle reaping is a timer, not an interleaving: it would only add nondeterminism. */
const AGENT_CONFIG: AgentConfig = {
  name: "fuzz-agent",
  systemPrompt: "be helpful",
  greeting: "hi",
  idleTimeoutMs: 0,
  maxSteps: 100,
};

const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    name: "lookup",
    description: "Look something up.",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: [] },
  },
];

/**
 * Events that mean the conversation is still happening. Reaching a client that
 * was told the session died is not cosmetic: `handleErrorEvent` in
 * `aai-ui/session-core-messages.ts` has already called `cleanupAudio()` and
 * bumped the connection generation, so the agent would be talking to a session
 * whose microphone is gone and whose UI says the call ended.
 */
const CONVERSATION_EVENTS = new Set<SessionEvent["type"]>([
  "user-transcript.committed",
  "user-transcript.updated",
  "agent-transcript.updated",
  "agent-transcript.committed",
  "reply.completed",
  "tool.called",
  "speech.started",
]);

/** A tool execution the harness is holding open until a command settles it. */
interface PendingTool {
  callId: string;
  settle(ok: boolean): void;
}

export interface Harness {
  session: ServerSession;
  link: FakeS2sLink;
  /** Every client event, in order. */
  events: SessionEvent[];
  /** Tool executions in flight, oldest first. */
  pendingTools: PendingTool[];
  /** Call ids whose execution has settled — a result exists to send. */
  settled: Set<string>;
  /** Calls no oracle may require an answer for (the client stranded them). */
  excused: Set<string>;
  /** stop() has resolved. */
  stopped: boolean;
  /** The client was told the session is over: `code: message`, or null. */
  declaredDead: string | null;
  /** Socket count when that happened — none may be opened after it. */
  socketsAtRetirement: number | null;
  /** A cancel is in force: audio must stay suppressed until the next reply. */
  audioSuppressed: boolean;
  /** Coverage counters, shared across every fast-check run. */
  cov: Record<string, number>;
}

/**
 * Let every pending microtask run. A macrotask boundary rather than N awaits:
 * the chains here are several deep (p-event's open race, then the transport's
 * connect continuation, then session-core's turn promise) and counting ticks is
 * how a flake gets written.
 *
 * `setImmediate`, not `setTimeout(0)`: this runs after every command of every
 * generated run — tens of thousands of times — and a timer's ~1ms floor put the
 * suite at ~60s on its own. Nothing in the S2S path arms a timer (the idle timer
 * is disabled, and the injected `executeTool` bypasses the tool executor's
 * `pTimeout`), so there is no timer callback for this to jump ahead of.
 */
export function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Throw, so fast-check shrinks to the shortest sequence that reproduces it. */
function fail(what: string): never {
  throw new Error(what);
}

/** A fatal `error` frame latches: the client has released its microphone. */
function noteFatalError(h: Harness, e: Extract<SessionEvent, { type: "error.reported" }>): void {
  h.declaredDead ??= `${e.code}: ${e.message}`;
  if (e.code === "connection") h.socketsAtRetirement ??= h.link.sockets.length;
}

/** `speech_stopped` must pair with a `speech_started` any client can have seen. */
function checkSpeechPairing(h: Harness): void {
  // One pass rather than two `filter().length` scans of the same array: this
  // runs on every `speech.stopped` of every generated run, so the log is walked
  // once per check instead of twice.
  let starts = 0;
  let stops = 0;
  for (const event of h.events) {
    if (event.type === "speech.started") starts += 1;
    else if (event.type === "speech.stopped") stops += 1;
  }
  if (stops > starts) fail("speech_stopped with no matching speech_started");
}

function makeSink(h: Harness): ClientSink {
  return {
    open: true,
    event(e) {
      if (h.stopped) fail(`event ${e.type} reached the client after stop() resolved`);
      // `audio.completed` is an ordinary event now rather than a sink method, so
      // the oracle that used to live in `playAudioDone` lives here.
      if (e.type === "audio.completed" && h.stopped) {
        fail("audio done reached the client after stop() resolved");
      }
      h.events.push(e);
      if (e.type === "error.reported" && e.fatal !== false) noteFatalError(h, e);
      else if (h.declaredDead !== null && CONVERSATION_EVENTS.has(e.type)) {
        fail(`${e.type} reached the client after a fatal [${h.declaredDead}]`);
      }
      if (e.type === "speech.stopped") checkSpeechPairing(h);
    },
    playAudioChunk() {
      if (h.stopped) fail("audio reached the client after stop() resolved");
      if (h.declaredDead !== null)
        fail(`audio reached the client after a fatal [${h.declaredDead}]`);
      if (h.audioSuppressed) {
        fail("audio reached the client after cancel, before the next reply started");
      }
    },
  };
}

/** The session id the harness's own first handshake answers with. */
export const FIRST_SESSION_ID = "sess-0";

/**
 * Build the stack and bring it to a LIVE session: socket 0 opened and its
 * handshake answered.
 *
 * Deliberately not left at "connected, awaiting handshake". The property is
 * about what happens to a session that is up, and every command that reaches
 * anything interesting (`reply.started` → `tool.call` → a drop → a resume) needs
 * a ready session first. While the first handshake was itself a generated
 * command, only ~20% of runs ever picked it early enough to get there and the
 * whole run was wasted: `toolExecuted` came in at 1 across 120 runs. The states
 * this gives up — a first connect that never opens, or is rejected — are
 * covered by the scripted specs in `host/s2s.test.ts`.
 */
export async function createHarness(cov: Record<string, number>): Promise<Harness> {
  const link = createFakeS2sLink();
  const h: Harness = {
    session: undefined as unknown as ServerSession,
    link,
    events: [],
    pendingTools: [],
    settled: new Set(),
    excused: new Set(),
    stopped: false,
    declaredDead: null,
    socketsAtRetirement: null,
    audioSuppressed: false,
    cov,
  };
  const hit = (key: string): void => {
    cov[key] = (cov[key] ?? 0) + 1;
  };

  let core: ServerSession | null = null;
  const bind = (): ServerSession => {
    // An invariant rather than an oracle failure: `core` is this function's own
    // local, filled in below, so a null here is the HARNESS mis-ordering itself
    // and must not read as a finding about the transport under test. Same shape
    // as `bindCore` in `runtime.ts`.
    invariant(core !== null, "s2s.fuzz.core.bound");
    return core;
  };
  // Twelve flat forwards, one per event name, until the transport boundary became
  // the wire vocabulary itself. Nothing here models anything any more — which is
  // the point: this harness runs the REAL `buildSessionCallbacks` decisions
  // nowhere, so a forwarding table it maintained by hand was a second, drifting
  // copy of one.
  const callbacks: TransportCallbacks = {
    report: (event) => bind().report(event),
    onReplyStarted: (id) => bind().onReplyStarted(id),
    onAudioChunk: (b) => bind().onAudioChunk(b),
  };

  const transport = createS2sTransport({
    apiKey: "test-key",
    s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
    sessionConfig: { systemPrompt: "be helpful", tools: TOOL_SCHEMAS, greeting: "hi" },
    callbacks,
    sid: "fuzz",
    agent: "fuzz-agent",
    createWebSocket: link.createWebSocket,
    logger: silentLogger,
  });

  const sink = makeSink(h);
  core = createSessionCore({
    id: "fuzz",
    agent: "fuzz-agent",
    client: sink,
    // A real emitter over a real stream on the memory backend: the stamping and
    // the client-then-hooks ordering are part of what this property exercises,
    // and every oracle above reads the SINK, so a stub would only hide the seam.
    emitter: createSessionEmitter({
      sessionId: "fuzz",
      client: sink,
      // A REAL stream on the memory backend, not a stub: the stamping, the index
      // assignment and the client-then-hooks ordering are part of what the
      // property exercises, and every oracle above reads the sink the emitter
      // writes to. Built here rather than with `_test-utils.ts`'s `makeEmitter`
      // for the reason at the top of this file — these modules must not import
      // the vitest-backed helpers.
      stream: createSessionEventStream({ backend: createMemoryStateBackend() }),
    }),
    agentConfig: AGENT_CONFIG,
    transport,
    logger: silentLogger,
    // Modelled on the REAL executor (`tool-executor.ts`), whose contract is
    // narrower than `ExecuteTool`'s type suggests, in two ways that both bit
    // this harness:
    //
    //  - It NEVER REJECTS. A throwing tool, a timeout, an abort — all come back
    //    as `serializeToolFailure(...)` strings, so "the tool blew up" is a resolved value.
    //  - An ALREADY-ABORTED signal is handled explicitly, because an abort
    //    listener on one never fires. `ServerSession.onCancel` aborts the reply
    //    WITHOUT replacing it, so a `tool.call` arriving after a client cancel
    //    gets exactly that signal. Only listening for `abort` left the promise
    //    pending forever, `stop()` awaiting the turn, and the property reporting
    //    a 5s hang against a transport that was behaving perfectly.
    executeTool: (_name, _args, _sid, _messages, opts) => {
      const callId = opts?.toolCallId ?? "unknown";
      hit("toolExecuted");
      return new Promise<string>((resolve) => {
        let done = false;
        const finish = (result: string): void => {
          if (done) return;
          done = true;
          h.settled.add(callId);
          h.pendingTools = h.pendingTools.filter((t) => t.callId !== callId);
          resolve(result);
        };
        const signal = opts?.signal;
        if (signal?.aborted === true) {
          hit("toolCancelledBeforeRun");
          finish(serializeToolFailure(`Tool "lookup" was cancelled before it ran`));
          return;
        }
        signal?.addEventListener("abort", () => {
          hit("toolAbortedBySession");
          finish(serializeToolFailure("aborted"));
        });
        h.pendingTools.push({
          callId,
          settle: (ok) =>
            finish(ok ? `result for ${callId}` : serializeToolFailure("tool blew up")),
        });
      });
    },
  });
  h.session = core;

  const started = core.start();
  await drain();
  const first = link.sockets[0];
  first?.open();
  await started;
  first?.deliver({ type: "session.ready", session_id: FIRST_SESSION_ID });
  if (first !== undefined) first.sessionId = FIRST_SESSION_ID;
  link.issuedSessionIds.add(FIRST_SESSION_ID);
  await drain();
  return h;
}
