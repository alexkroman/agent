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
 * Because the client protocol has no text command. A user turn reaches a session
 * as PCM and nothing else (`sdk/protocol-commands.ts` — five commands, none of
 * them an utterance), so a text-driven eval has no socket to speak down. Host
 * mode is unaffected; it is simply the wrong seam for a text target, and the
 * seam that IS right is the one below the wire.
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

import type { AgentDef } from "@alexkroman1/aai";
import type { ProviderEnv, RunCodeExecutor } from "@alexkroman1/aai/host-internal";
import { invariant, sleep } from "@alexkroman1/aai/internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { ClientSink, SessionEvent } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import type { HostGenerateFn } from "../generate.ts";
import { withHostCredentialFallback } from "../providers/host-env.ts";
import { requiredProviderEnvVars } from "../providers/resolve.ts";
import { createRuntime } from "../runtime.ts";
import { type Logger, silentLogger } from "../runtime-config.ts";
import { credentialVerdict } from "./_credential-verdict.ts";
import { assertTurnMeasurable } from "./_turn-faults.ts";
import { type EvalToolCall, saidIn, TURN_ENDS, toolCallsInEvents } from "./events.ts";
import { installStubSpeechProviders, type StubSpeechProviders } from "./stub-speech.ts";

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
 * One turn: what the agent did between an utterance and the end of its reply.
 *
 * `say()` hands one back because "on that turn" is most of the meaning of almost
 * every claim an eval makes. `calledTool("get_weather")` over a whole call is a
 * much weaker statement than the same thing about the reply to one question, and
 * a whole-run reader cannot express the stronger one without hand-slicing the
 * event list — which is how an eval comes to assert against the GREETING, a real
 * turn that lands in `said()` before the case has said anything at all.
 */
export type EvalTurn = {
  /** The agent's committed reply, joined — what the caller was told. */
  readonly text: string;
  /** This turn's events, from the committed utterance to the terminator. */
  readonly events: readonly SessionEvent[];
  /** This turn's tool calls, in call order, each with its result. */
  readonly toolCalls: readonly EvalToolCall[];
  /**
   * The reply ended on its own terms (`reply.completed`) rather than being
   * cancelled. A cancelled reply is a finding, not a failure of the harness.
   */
  readonly completed: boolean;
};

/** One live eval session. */
export type EvalSession = {
  /**
   * This session's id — what its tools read as `ctx.sessionId`.
   *
   * Exposed because it is what a tool CORRELATES a durable run with, so a case
   * asserting "the run it started is this conversation's" needs both halves.
   */
  readonly id: string;
  /**
   * Commit a user turn, wait for the reply to end, and hand back that turn.
   *
   * Waits for a reply TERMINATOR rather than for a timer, which is what makes a
   * case deterministic despite a live model: the next `say()` cannot begin
   * inside the previous turn, so a recorded tool order is the agent's and not
   * the harness's.
   */
  say(text: string): Promise<EvalTurn>;
  /**
   * Say every line in order, waiting out each reply, and hand back every turn.
   *
   * Byte-identical in three shipped templates before it was published
   * (`dispatch-center`, `retail`, `travel-concierge`), each under a doc reaching
   * the same conclusion independently — which is the tell that it is the
   * harness's concept rather than any template's. The conclusion is the reason
   * to reach for this rather than a list of `say()` calls: a case over several
   * turns must assert about the turn a MECHANISM fired in, never about turn
   * number two, because how many turns an agent takes to get somewhere is the
   * model's business and it measurably varies — `retail`'s desk reads the order
   * back before it stages, so its staging call has landed in turn two, three
   * and four across live runs. A case pinned to a turn index is a flake with a
   * misleading name.
   *
   * `turnCalling`, `toolCallsInTurns` and `describeTurn` (`eval/turns.ts`, published on
   * the same subpath) are what read the result without pinning an index.
   *
   * Strictly sequential, like the caller it stands for: each line is committed
   * only once the reply to the previous one has ended, so a recorded tool order
   * is the agent's and not the harness's.
   */
  sayAll(lines: readonly string[]): Promise<readonly EvalTurn[]>;
  /** Every event this session has emitted, in stream order. */
  events(): readonly SessionEvent[];
  /**
   * Every committed reply so far, INCLUDING the greeting — the agent's opening
   * line is a real turn and is in the session's history, so it is in this list
   * too. Prefer the {@link EvalTurn} `say()` returns for a claim about one
   * reply.
   */
  said(): readonly string[];
  /** The tool calls so far, in call order, each with its result. */
  toolCalls(): readonly EvalToolCall[];
  close(): Promise<void>;
};

/** What {@link openEvalSession} takes. */
export type EvalSessionOptions = {
  /** The agent under eval — an ordinary `agent()` definition. */
  readonly agent: AgentDef;
  /**
   * The agent's own env, i.e. what its tools read as `ctx.env`. Defaults to
   * empty: a tool that needs a value gets it here, and nothing is inherited
   * implicitly.
   */
  readonly env?: Record<string, string>;
  /**
   * Where provider credentials are resolved from. Defaults to
   * {@link EvalSessionOptions.env} with any credential it does not carry filled
   * in from this machine's own environment — the same trust decision
   * `withHostCredentialFallback` makes explicit for `aai dev`, and right here
   * for the same reason: an eval runs on the developer's box against their own
   * key. A value passed in `env` always wins over the shell.
   */
  readonly providerEnv?: ProviderEnv;
  /** Override the LLM the case runs on. Defaults to the agent's own. */
  readonly llm?: LlmProvider;
  /**
   * Backs the `run_code` builtin.
   *
   * Without one the builtin is registered and permanently refuses, exactly as it
   * does off-platform — the Modal container is the security boundary and nothing
   * here pretends otherwise. What that COSTS was measured on the three tutor
   * templates: their headline feature was unevaluable, because the agent calls
   * `run_code`, reads "only available in the sandboxed runtime", and then does
   * the arithmetic in its head — so a case could asserted the CALL and never the
   * answer. An eval on a developer's own machine may supply an executor; a
   * deployed agent still cannot.
   */
  readonly runCode?: RunCodeExecutor;
  /**
   * The `fetch` the builtin web tools use. Pass one to keep a case off the
   * network — a scripted `visit_webpage` really visits.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Per-tool-call deadline. Defaults to the session's own (30s, a voice-turn
   * budget). A tool whose work legitimately outruns that — a graded retrieval
   * loop making eleven model calls, measured at 22-30s — cannot otherwise be
   * evaluated at all: the executor answers a timeout and the case measures the
   * deadline instead of the agent.
   */
  readonly toolTimeoutMs?: number;
  /**
   * What tool code calls as `ctx.generate`. Absent, it is the agent's own LLM.
   *
   * `describeEval`'s `stubGenerate` builds one of these; the reason it must be
   * separate from the turn's script is in `RuntimeOptions.generate`.
   */
  readonly generate?: HostGenerateFn;
  /**
   * `ctx.workflows` for this session — what a tool that starts a durable run
   * calls.
   *
   * Without one, a workflow-declaring agent gets the client the runtime builds
   * over the Workflow DevKit, and every `start()` through it throws: the
   * compiler's transform never ran on a body imported through a test runner, so
   * `def.run.workflowId` is absent and there is nothing for the adapter to
   * start. That is a tool an eval cannot execute at all, which is the gap this
   * closes. Build one with `openEvalWorkflows({ agent })` and pass its `client`;
   * `describeEval` does that for you.
   *
   * The engine under it is not durable — no journal, no replay, no retry. See
   * `eval/workflow-engine.ts` before writing a claim about a run.
   */
  readonly workflows?: WorkflowClient | undefined;
  readonly turnTimeoutMs?: number;
  /** Defaults to silent. Pass `consoleLogger` when diagnosing a case. */
  readonly logger?: Logger;
};

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
  const fake = installStubSpeechProviders();
  try {
    return await openWithFakes(options, fake);
  } catch (err) {
    fake.release();
    throw err;
  }
}

async function openWithFakes(
  options: EvalSessionOptions,
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
  const runtime = createRuntime({
    // `omitUndefined`, not `...omitUndefined({ llm })`: the conditional spread
    // of an object literal is the idiom `guard-invariants` rule 2 exists to keep
    // out, and the truthiness spelling is the one its regex cannot see.
    agent: {
      ...options.agent,
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
  const session = runtime.createSession({
    id: sessionId,
    agent: options.agent.name,
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
    if (options.agent.greeting !== undefined && options.agent.greeting !== "") {
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
    const stt = fake.sttSession();
    // The handle this closure belongs to is only returned after
    // `session.start()` resolved, which is what opens the STT stage, and the
    // fake never clears the stream it last opened — so an absent one is this
    // module having reordered its own start, not a case doing anything.
    invariant(stt !== undefined, "eval.session.stt.open", () => ({ sessionId }));
    const from = events.length;
    stt.commit(text);
    await waitFor(`a reply to ${JSON.stringify(text.slice(0, 60))}`, repliedTo, from);
    const turn = events.slice(from);
    assertTurnMeasurable(
      `the reply to ${JSON.stringify(text.slice(0, 60))}`,
      turn,
      toolNames,
      "voice",
    );
    return {
      text: saidIn(turn).join(" "),
      events: turn,
      toolCalls: toolCallsInEvents(turn),
      completed: turn.some((e) => e.type === "reply.completed"),
    };
  };

  return {
    id: sessionId,
    events: () => events,
    said: () => saidIn(events),
    toolCalls: () => toolCallsInEvents(events),
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
