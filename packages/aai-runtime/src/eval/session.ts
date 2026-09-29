// Copyright 2026 the AAI authors. MIT license.
/**
 * The TEXT-DRIVEN eval session: a real agent, driven by what a caller SAID.
 *
 * What is real here: `createRuntime`, the pipeline transport, the LLM (a live
 * provider on a live key), the tool executor, `ctx` and its slots, history
 * trimming, the step budget, and the session event stream the assertions read.
 * What is not: the two speech stages (see `stub-speech.ts`) and the client — a
 * recording {@link ClientSink} stands in for a browser.
 *
 * That is the whole point of the split. A voice agent's input is paced PCM, and
 * the audio boundary is where the two eval levels divide:
 *
 * - **Above it** — tool choice, tool arguments, tool ORDER, step count, what the
 *   agent said, history handling. This module.
 * - **Below it** — endpointing, splits and merges, barge-in, and the
 *   `speech.started`/`reply.cancelled` ratio. NOT this module, and nothing
 *   driven through it can say anything about one: a committed transcript arrives
 *   because the harness said so, at the instant it said so.
 *
 * Neither substitutes for the other, and an eval written here must not be
 * described as if it covered the second. A turn-taking replay harness cannot
 * settle a tool-choice regression, and this cannot see an endpointing bug.
 *
 * ## Why not a `?host=1` WebSocket
 *
 * This was written when the client protocol had no text command, and the answer
 * outlived that. There is one now — `user_text` in `sdk/protocol-commands.ts` —
 * but it is a TYPED turn, answered past the transcriber: no quiet-final drop, no
 * push-to-talk window, no barge-in thresholds. An eval driven through it would
 * grade a path a voice caller never takes. The fake transcriber below commits
 * `text` where a real one would (`stt.commit`), so the turn under test is the
 * spoken one the agent ships for, and host mode stays the wrong seam for a text
 * target — the seam that IS right is the one below the wire.
 *
 * The cost of that is stated rather than papered over: this does not exercise
 * `ws-handler.ts`, the audio pacer, or frame ordering. Those have unit and
 * scenario coverage; what had none was "given this utterance, did the agent do
 * the right thing".
 *
 * ```ts no-check
 * import { evalCredentials, openEvalSession } from "@alexkroman1/aai-runtime/eval";
 * import agentDef from "./agent.ts";
 *
 * const creds = evalCredentials(agentDef);
 * const session = await openEvalSession({ agent: agentDef });
 * try {
 *   const turn = await session.say("what can you help me with?");
 *   expect(turn.text).toMatch(/order/i);
 * } finally {
 *   await session.close();
 * }
 * ```
 *
 * @module
 */

import type { AgentDef, SessionEvent } from "@alexkroman1/aai";
import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import { invariant, sleep } from "@alexkroman1/aai/internal";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { withHostCredentialFallback } from "../providers/host-env.ts";
import { requiredProviderEnvVars } from "../providers/resolve.ts";
import { createRuntimeWithSeams } from "../runtime.ts";
import { silentLogger } from "../runtime-config.ts";
import { SessionRefusedError } from "../session-attach-end.ts";
import { credentialVerdict } from "./_credential-verdict.ts";
import { checkedIdentity, observeSessionContext, recordIdentity } from "./_session-identity.ts";
import { assertTurnMeasurable, measuredToolCalls, measuredTurn } from "./_turn-faults.ts";
import { saidIn, TURN_ENDS } from "./events.ts";
import type {
  EvalSession,
  EvalSessionOptions,
  EvalTurn,
  HostEvalSessionOptions,
} from "./session-types.ts";
import { installStubSpeechProviders, type StubSpeechProviders } from "./stub-speech.ts";

// Declared beside each other in `session-types.ts`, re-exported here so the
// barrels and every relative importer keep naming this module.
export type {
  EvalSession,
  EvalSessionOptions,
  EvalTurn,
  HostEvalSessionOptions,
} from "./session-types.ts";

/** How long one turn may take before the harness gives up on it. */
const DEFAULT_TURN_TIMEOUT_MS = 90_000;
/** How often the turn wait re-reads the event list. */
const POLL_MS = 25;

/** What {@link evalCredentials} found on this machine. */
export type EvalCredentials = {
  /**
   * The provider credentials the host environment carries, ready to hand to
   * {@link EvalSessionOptions.providerEnv}. Only provider-credential names are
   * copied, so no unrelated host variable can reach the agent.
   */
  readonly env: ProviderEnv;
  /** Credential names this agent needs and this machine does not have. */
  readonly missing: readonly string[];
  /** Nothing missing — an eval can run. */
  readonly ready: boolean;
  /** Why an eval would skip, phrased as the fix. `undefined` when ready. */
  readonly reason: string | undefined;
};

/**
 * Can this machine run evals against `agent`?
 *
 * An eval spends real tokens on a real key, so a suite that cannot find one has
 * to SKIP — and a silent skip is the worst outcome available, because a green
 * run of nothing is indistinguishable from a green run of something. This is
 * the gate: it reports what is missing so the skip can say how to fix itself.
 *
 * **It asks "can this machine run this AGENT", not "which keys does a
 * text-driven eval dial".** Those differ: the speech stages are faked, so an
 * agent declaring `stt: deepgram()` never opens Deepgram here. Answering the
 * narrower question would let an eval pass on a machine where the agent's own
 * `aai dev` cannot start, and the second answer also changes whenever the fakes
 * change — a gate whose meaning moves under it is not a gate.
 */
export function evalCredentials(
  agent: AgentDef,
  hostEnv: Record<string, string | undefined> = process.env,
): EvalCredentials {
  const env = withHostCredentialFallback({}, hostEnv);
  const missing = requiredProviderEnvVars(agent).filter((name) => !env[name]);
  return {
    env,
    ...credentialVerdict(missing),
  };
}

/**
 * Open an eval session against a real runtime.
 *
 * The agent definition is used AS GIVEN apart from its two speech stages, which
 * is the property that matters: an eval measures the agent an author wrote,
 * including its `events` hooks, its slots and its `tools/` files.
 *
 * @throws if the agent declares `s2s`. A speech-to-speech agent has no pipeline
 *   to fake the two ends of — the vendor owns the whole turn — so there is no
 *   text seam to drive it from, and quietly running it as a pipeline agent would
 *   evaluate a configuration nobody deployed.
 */
export async function openEvalSession(options: EvalSessionOptions): Promise<EvalSession> {
  return openEvalSessionWithSeams(options);
}

/**
 * {@link openEvalSession} plus the host-only seam of
 * {@link HostEvalSessionOptions}. `describeEval` is the caller.
 *
 * @internal
 */
export async function openEvalSessionWithSeams(
  options: HostEvalSessionOptions,
): Promise<EvalSession> {
  if (options.agent.s2s !== undefined) {
    throw new Error(
      `Agent "${options.agent.name}" declares an s2s provider, which owns the whole ` +
        "turn — a text-driven eval has no seam to drive it from. Evaluate a " +
        "pipeline (stt/llm/tts) configuration, or drive the deployed agent with audio.",
    );
  }
  // Everything between the install and the returned `close()` is wrapped,
  // because `installStubSpeechProviders` registers a PROCESS-GLOBAL kind pair and the
  // only thing that unregisters it is the handle this function returns. A throw
  // in between — a runtime that will not start, an agent whose provider config
  // is wrong, the greeting timing out — left the pair registered for the
  // worker's life with nobody holding a release, so five repeats against a
  // failing agent orphaned five of them. A runner that catches the throw and
  // runs the next repeat is exactly what makes the leak compound.
  // Before the install, so a typo'd phone number throws with nothing to release.
  const identity = checkedIdentity(options);
  const fake = installStubSpeechProviders();
  try {
    return await openWithFakes({ ...options, ...identity }, fake);
  } catch (err) {
    fake.release();
    throw err;
  }
}

async function openWithFakes(
  options: HostEvalSessionOptions,
  fake: StubSpeechProviders,
): Promise<EvalSession> {
  const events: SessionEvent[] = [];
  const sink: ClientSink = {
    open: true,
    event(e) {
      events.push(e);
    },
    playAudioChunk() {
      // A text-driven eval discards agent audio: the fakes synthesize silence,
      // and the caller's ear is the other level's subject.
    },
  };

  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const providerEnv = options.providerEnv ?? withHostCredentialFallback({ ...options.env });
  // The agent's own hook, watched rather than replaced — see `_session-identity.ts`.
  const observed = observeSessionContext(options.agent);
  // The seams variant, for `generate` — a host-only option (`HostRuntimeOptions`).
  const runtime = createRuntimeWithSeams({
    // `omitUndefined`, not `...omitUndefined({ llm })`: the conditional spread
    // of an object literal is the idiom `guard-invariants` rule 2 exists to keep
    // out, and the truthiness spelling is the one its regex cannot see.
    agent: {
      ...observed.agent,
      stt: fake.stt,
      tts: fake.tts,
      ...omitUndefined({ llm: options.llm }),
    },
    env: { ...options.env, ...fake.env },
    providerEnv: { ...providerEnv, ...fake.env },
    // Absent, the runtime builds its own over the DevKit — which is right
    // everywhere but here. See `EvalSessionOptions.workflows`.
    //
    // One `omitUndefined` over the four optional seams rather than four
    // conditional spreads: `guard-invariants` rule 2.
    ...omitUndefined({
      workflows: options.workflows,
      runCode: options.runCode,
      fetch: options.fetch,
      toolTimeoutMs: options.toolTimeoutMs,
      generate: options.generate,
    }),
    logger: options.logger ?? silentLogger,
  });

  // The RESOLVED set — the agent's own tools plus whichever builtins it enabled,
  // which is what the model was offered. Read off the runtime rather than
  // recomputed from `agent.tools`, so the diagnosis below cannot come to
  // disagree with what the LLM saw.
  const toolNames = runtime.toolSchemas.map((schema) => schema.name);

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

  const sessionId = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Where a socket records `?client=`/`?phone=` and a carrier stream its call:
  // after the id is decided, before the session is built.
  recordIdentity(sessionId, options);
  const session = runtime.createSession({
    id: sessionId,
    agent: options.agent.name,
    client: sink,
  });

  let refused: string | undefined;
  try {
    session.configure(runtime.readyConfig);
    refused = await startOrRefusal(session);
    // The greeting is a real turn and belongs in the session's history, so it is
    // driven and awaited rather than skipped: an agent whose opening line asks a
    // question is answered by the case's first `say()`, exactly as a caller
    // would. Whose greeting is `sessionContext`'s to say, so it is read AFTER
    // `start()`, which is where the hook answered.
    const greetingFrom = events.length;
    if (refused === undefined) session.command({ type: "audio_ready" });
    if (refused === undefined && observed.greeting() !== "") {
      await waitFor(
        "the greeting",
        (since) => since.some((e) => TURN_ENDS.has(e.type)),
        greetingFrom,
      );
      // The EARLIEST place a rejected credential is visible, and the cheapest to
      // read: a case that has not said anything yet cannot have written an
      // assertion this could be confused with.
      assertTurnMeasurable("the greeting", events.slice(greetingFrom), toolNames, "voice");
    }
  } catch (err) {
    // The runtime is live from `createRuntime` onward and the caller never
    // receives a handle down this path, so nothing else can shut it down. A
    // greeting that times out is the realistic case, and a runner starts the
    // next repeat immediately afterwards. Best-effort on both, because the
    // ORIGINAL failure is the one worth reporting.
    await session.stop().catch(() => undefined);
    await runtime.shutdown().catch(() => undefined);
    throw err;
  }

  // A binding rather than a method on the literal below, so `sayAll` reaches it
  // without `this` — a handle destructured out of a case's context
  // (`async ({ session }) => …`) is exactly the shape that makes a `this`-bound
  // method fail somewhere the type checker cannot see.
  const say = async (text: string): Promise<EvalTurn> => {
    if (refused !== undefined) {
      throw new Error(
        `eval session: cannot say ${JSON.stringify(text.slice(0, 60))} — the agent's ` +
          `sessionContext REFUSED this session (${JSON.stringify(refused)}), so it never ` +
          "started. Assert on `session.refused` for a case about the refusal.",
      );
    }
    const stt = fake.sttSession();
    // The handle this closure belongs to is only returned after
    // `session.start()` resolved, which is what opens the STT stage, and the
    // fake never clears the stream it last opened — so an absent one is this
    // module having reordered its own start, not a case doing anything.
    invariant(stt !== undefined, "eval.session.stt.open", () => ({ sessionId }));
    const from = events.length;
    // A push-to-talk agent answers only what was RELEASED: frame the utterance
    // as its client does, or the final is held and every case times out.
    const manual = options.agent.turnDetection === "manual";
    if (manual) session.command({ type: "user_turn_start" });
    stt.commit(text);
    if (manual) session.command({ type: "user_turn_commit" });
    await waitFor(`a reply to ${JSON.stringify(text.slice(0, 60))}`, repliedTo, from);
    const what = `the reply to ${JSON.stringify(text.slice(0, 60))}`;
    return measuredTurn(what, events.slice(from), toolNames, "voice", options.agent);
  };

  return {
    id: sessionId,
    refused,
    events: () => events,
    said: () => saidIn(events),
    toolCalls: () => measuredToolCalls(events, options.agent),
    say,
    async sayAll(lines) {
      const turns: EvalTurn[] = [];
      // Sequential on purpose: `say()` returns when the reply to ITS utterance
      // ends, so awaiting each in turn is what keeps the next line out of the
      // previous turn. A `Promise.all` here would commit every utterance at
      // once and record an order belonging to the harness.
      for (const line of lines) turns.push(await say(line));
      return turns;
    },
    async close() {
      await session.stop();
      await runtime.shutdown();
      fake.release();
    },
  };
}

/**
 * Start `session`, answering the app's refusal reason when its `sessionContext`
 * refused — `undefined` when it started.
 *
 * The refusal is the runtime's own (`runtime-session-stream.ts` throws it
 * before the transport starts); this only turns it into a value, and stops the
 * session as `session-attach.ts` does for a refused connection. Any other
 * failure to start is still a throw.
 */
async function startOrRefusal(session: {
  start(): Promise<void>;
  stop(): Promise<void>;
}): Promise<string | undefined> {
  try {
    await session.start();
    return undefined;
  } catch (err) {
    if (!(err instanceof SessionRefusedError)) throw err;
    await session.stop().catch(() => undefined);
    return err.reason;
  }
}
