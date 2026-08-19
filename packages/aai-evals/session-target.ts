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
import { omitUndefined } from "@alexkroman1/aai/utils";
import { type EvalScope, eventScope, TURN_ENDS } from "./assertions.ts";
import { type FakeSpeech, installFakeSpeech } from "./fake-speech.ts";
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

// "What ends a reply" is `assertions.ts`'s `TURN_ENDS`, imported rather than
// restated. It was declared in both files, and the two must agree by
// construction: a third terminator added to one copy would make `say()` return
// mid-reply while the assertions still thought the turn was open — which reads
// as the agent misbehaving, the exact class of harness bug this package's guide
// records having been bitten by twice.

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
  // Everything between the install and the returned `close()` is wrapped,
  // because `installFakeSpeech` registers a PROCESS-GLOBAL kind pair and the
  // only thing that unregisters it is the handle this function returns. A throw
  // in between — a runtime that will not start, an agent whose provider config
  // is wrong, the greeting timing out — left the pair registered for the
  // worker's life with nobody holding a release, so `AAI_EVAL_REPEAT=5` against
  // a failing agent orphaned five of them. `runEval` catches the throw and runs
  // the next repeat, which is exactly what makes the leak compound.
  const fake = installFakeSpeech();
  try {
    return await openWithFakes(opts, fake);
  } catch (err) {
    fake.release();
    throw err;
  }
}

async function openWithFakes(opts: EvalSessionOptions, fake: FakeSpeech): Promise<EvalSession> {
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
    // `omitUndefined`, not `...omitUndefined({ llm })`: the conditional spread
    // of an object literal is the idiom `guard-invariants` rule 2 exists to keep
    // out, and the truthiness spelling is the one its regex cannot see.
    agent: { ...opts.agent, stt: fake.stt, tts: fake.tts, ...omitUndefined({ llm: opts.llm }) },
    env: { ...opts.env, ...fake.env },
    logger: opts.logger ?? silentLogger,
  });

  const waitFor = async (
    what: string,
    ready: (since: readonly SessionEvent[]) => boolean,
    from: number,
  ): Promise<void> => {
    const deadline = Date.now() + turnTimeoutMs;
    for (;;) {
      const since = events.slice(from);
      if (ready(since)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `eval session timed out after ${turnTimeoutMs}ms waiting for ${what}; ` +
            `events since: ${since.map((e) => e.type).join(", ")}`,
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

  const session = runtime.createSession({
    id: `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    agent: opts.agent.name,
    client: sink,
  });

  try {
    session.configure(runtime.readyConfig);
    await session.start();

    // The greeting is a real turn and belongs in the session's history, so it is
    // driven and awaited rather than skipped: an agent whose opening line asks a
    // question is answered by the case's first `say()`, exactly as a caller
    // would.
    const greetingFrom = events.length;
    session.command({ type: "audio_ready" });
    if (opts.agent.greeting !== undefined && opts.agent.greeting !== "") {
      await waitFor(
        "the greeting",
        (since) => since.some((e) => TURN_ENDS.has(e.type)),
        greetingFrom,
      );
    }
  } catch (err) {
    // The runtime is live from `createRuntime` onward and the caller never
    // receives a handle down this path, so nothing else can shut it down. A
    // greeting that times out is the realistic case, and `runEval` starts the
    // next repeat immediately afterwards. Best-effort on both, because the
    // ORIGINAL failure is the one worth reporting.
    await session.stop().catch(() => undefined);
    await runtime.shutdown().catch(() => undefined);
    throw err;
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
