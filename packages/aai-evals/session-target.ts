// Copyright 2026 the AAI authors. MIT license.
/**
 * The LEVEL 1 target: a real session, driven by text.
 *
 * What is real here: `createRuntime`, the pipeline transport, the LLM (a live
 * provider on a live key), the tool executor, `ctx` and its slots, history
 * trimming, the step budget, and the session event stream this eval's assertions
 * read. What is not: the two speech stages (see `fake-speech.ts`) and the client
 * — a recording {@link ClientSink} stands in for a browser.
 *
 * ## Why not a `?host=1` WebSocket
 *
 * The plan asked whether level 1 should drive host mode, and the answer turned
 * out to be that it CANNOT: the client protocol has no text command. A user turn
 * reaches a session as PCM and nothing else (`sdk/protocol-commands.ts` — five
 * commands, none of them an utterance), so a text-driven level 1 has no socket
 * to speak down. Host mode is unaffected and unblocked; it is simply the wrong
 * seam for a text target, and the seam that IS right is the one below the wire.
 *
 * The cost of that is stated rather than papered over: level 1 does not exercise
 * `ws-handler.ts`, the audio pacer, or frame ordering. Those have unit and
 * scenario coverage; what had none was "given this utterance, did the agent do
 * the right thing".
 *
 * @module
 */

import type { AgentDef } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { ClientSink, SessionEvent } from "@alexkroman1/aai/protocol";
import { createRuntime, type Logger } from "@alexkroman1/aai/runtime";
import { type EvalScope, eventScope } from "./assertions.ts";
import { installFakeSpeech } from "./fake-speech.ts";
import type { EvalRecorder } from "./runner.ts";

/** How long one turn may take before the harness gives up on it. */
const DEFAULT_TURN_TIMEOUT_MS = 90_000;
/** How often the turn wait re-reads the event list. */
const POLL_MS = 25;

const dropLine = (): undefined => undefined;

/** A logger that says nothing — the default, so a report stays readable. */
const silentLogger: Logger = {
  debug: dropLine,
  info: dropLine,
  warn: dropLine,
  error: dropLine,
};

/** The events that end a reply, and so end a `say()`. */
const TURN_ENDS: ReadonlySet<SessionEvent["type"]> = new Set([
  "reply.completed",
  "reply.cancelled",
]);

/** One live level-1 session. */
export type EvalSession = {
  /**
   * Commit a user turn and wait for the reply to end.
   *
   * Waits for a reply TERMINATOR rather than for a timer, which is what makes a
   * case deterministic despite a live model: the next `say()` cannot begin
   * inside the previous turn, so a recorded tool order is the agent's and not
   * the harness's.
   */
  say(text: string): Promise<void>;
  /** Every event this session has emitted, in stream order. */
  events(): readonly SessionEvent[];
  /** An assertion scope over the whole session. */
  scope(recorder: EvalRecorder): EvalScope;
  close(): Promise<void>;
};

/** What {@link openEvalSession} takes. */
export type EvalSessionOptions = {
  /** The agent under eval — an ordinary `agent()` definition. */
  readonly agent: AgentDef;
  /** The agent env, including the provider credential the LLM resolves from. */
  readonly env: Record<string, string>;
  /** Override the LLM the case runs on. Defaults to the agent's own. */
  readonly llm?: LlmProvider;
  readonly turnTimeoutMs?: number;
  /** Defaults to silent. Pass `consoleLogger` when diagnosing a case. */
  readonly logger?: Logger;
};

/**
 * Open a level-1 session against a real runtime.
 *
 * The agent definition is used AS GIVEN apart from its two speech stages, which
 * is the property that matters: a case evaluates the agent an author wrote,
 * including its `events` hooks, its slots and its `tools/` files.
 */
export async function openEvalSession(opts: EvalSessionOptions): Promise<EvalSession> {
  const fake = installFakeSpeech();
  const events: SessionEvent[] = [];
  const sink: ClientSink = {
    open: true,
    event(e) {
      events.push(e);
    },
    playAudioChunk() {
      // Level 1 discards agent audio: the fakes synthesize silence, and the
      // caller's ear is level 2's subject.
    },
  };

  const turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const runtime = createRuntime({
    agent: { ...opts.agent, stt: fake.stt, tts: fake.tts, ...(opts.llm ? { llm: opts.llm } : {}) },
    env: { ...opts.env, ...fake.env },
    logger: opts.logger ?? silentLogger,
  });

  const session = runtime.createSession({
    id: `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    agent: opts.agent.name,
    client: sink,
  });
  session.configure(runtime.readyConfig);
  await session.start();

  const waitFor = async (
    what: string,
    ready: (since: readonly SessionEvent[]) => boolean,
    from: number,
  ): Promise<void> => {
    const deadline = Date.now() + turnTimeoutMs;
    for (;;) {
      if (ready(events.slice(from))) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `eval session timed out after ${turnTimeoutMs}ms waiting for ${what}; ` +
            `events since: ${events
              .slice(from)
              .map((e) => e.type)
              .join(", ")}`,
        );
      }
      await sleep(POLL_MS);
    }
  };

  /**
   * The reply to THIS utterance has ended.
   *
   * Not "a reply has ended", which is what the first draft waited for and which
   * is wrong in a way that reads as the agent misbehaving: a terminator can
   * belong to the PREVIOUS reply (a `reply.cancelled` from a barge-in, a late
   * completion), so `say()` returned before the model had run and the case
   * recorded "called no tools". The utterance's own
   * `user-transcript.committed` is the anchor — every event of its reply follows
   * it.
   */
  const repliedTo = (since: readonly SessionEvent[]): boolean => {
    const at = since.findIndex((e) => e.type === "user-transcript.committed");
    return at !== -1 && since.slice(at).some((e) => TURN_ENDS.has(e.type));
  };

  // The greeting is a real turn and belongs in the session's history, so it is
  // driven and awaited rather than skipped: an agent whose opening line asks a
  // question is answered by the case's first `say()`, exactly as a caller would.
  const greetingFrom = events.length;
  session.command({ type: "audio_ready" });
  if (opts.agent.greeting !== undefined && opts.agent.greeting !== "") {
    await waitFor(
      "the greeting",
      (since) => since.some((e) => TURN_ENDS.has(e.type)),
      greetingFrom,
    );
  }

  return {
    events: () => events,
    scope: (recorder) => eventScope(recorder, events),
    async say(text) {
      const stt = fake.sttSession();
      if (stt === undefined) throw new Error("eval session has no open STT stream");
      const from = events.length;
      stt.commit(text);
      await waitFor(`a reply to ${JSON.stringify(text.slice(0, 60))}`, repliedTo, from);
    },
    async close() {
      await session.stop();
      await runtime.shutdown();
      fake.release();
    },
  };
}
