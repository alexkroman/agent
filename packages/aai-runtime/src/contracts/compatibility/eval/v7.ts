// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:eval` epoch 7.
 *
 * Driving an agent from TEXT to measure what it did, written the way it was
 * authored at epoch 7 — a session with its two speech stages faked, the readers
 * over its event stream, and the vitest suite that chooses between a live model
 * and a scripted one. It must keep compiling for as long as that epoch is
 * advertised as supported.
 *
 * ## What moved, and why epoch 7 survives it
 *
 * Epoch 8 added three names and removed none: `DEFAULT_RUN_TIMEOUT_MS`,
 * `EvalWorkflowEngineOptions` and `HostGenerateFn`. All three were already
 * REACHABLE at epoch 7 — they are the types `EvalRunOptions.timeoutMs`,
 * `EvalWorkflowsOptions.speech` and `EvalSessionOptions.generate` are written
 * against — and a case could pass a value for any of those fields. What it
 * could not do is NAME one, so a shared fixture had to be inferred at every
 * use. Publishing a name a signature already referenced adds an import path and
 * breaks nothing that compiled without it. That is what makes this a retain
 * rather than a drop.
 *
 * ## What an eval does NOT measure
 *
 * Everything below the audio boundary — endpointing, splits and merges,
 * barge-in. Those are properties of the boundary the fake speech stages remove,
 * and no assertion driven through this can say anything about one.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 7 has to be dropped with a reason.
 */

import { agent, workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import {
  completedOutput,
  createStubSttOpener,
  createStubTtsOpener,
  createVmRunCode,
  customEventsIn,
  DEFAULT_RUN_TIMEOUT_MS,
  describeToolCalls,
  describeTurn,
  type EvalCredentials,
  type EvalEmitted,
  type EvalRunOptions,
  type EvalSession,
  type EvalSessionOptions,
  type EvalSleep,
  type EvalTextAgent,
  type EvalTextAgentOptions,
  type EvalToolCall,
  type EvalTurn,
  type EvalWorkflowEngineOptions,
  type EvalWorkflowRun,
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  evalCredentials,
  evalWorkflowCredentials,
  type HostGenerateFn,
  installStubLlm,
  installStubSpeechProviders,
  type Logger,
  lastStateIn,
  openEvalSession,
  openEvalTextAgent,
  openEvalWorkflows,
  STUB_LLM_API_KEY_ENV,
  STUB_SPEECH_API_KEY_ENV,
  type StepFetch,
  type StubLlm,
  type StubScript,
  type StubSpeechProviders,
  type StubStep,
  type StubSttSession,
  type StubTtsSession,
  saidIn,
  statesIn,
  TURN_ENDS,
  toolArgsIn,
  toolCallsInEvents,
  toolCallsInTurns,
  toolNames,
  toolResultIn,
  toolResultsIn,
  turnCalling,
  type VmRunCodeOptions,
} from "../../../eval-barrel.ts";
import {
  type DescribeEvalOptions,
  describeEval,
  describeWorkflowEval,
  type EvalCaseOptions,
  type EvalMode,
  type EvalTest,
  type EvalTestContext,
  type EvalWorkflowCaseOptions,
  type EvalWorkflowTest,
  type EvalWorkflowTestContext,
  resolveEvalMode,
  resolveWorkflowEvalMode,
} from "../../../eval-vitest-barrel.ts";

/**
 * The agent under evaluation.
 *
 * EDIT THIS. Everything below is the harness; this is what is being measured.
 */
const support = agent({
  name: "Support",
  systemPrompt: "Look orders up before answering. Keep replies short.",
});

/** A text agent, which the session harness structurally cannot drive. */
const desk = agent({
  name: "Desk",
  systemPrompt: "Answer in one line.",
  text: true,
});

/** ── EDIT: the workflow half. ──────────────────────────────────────────── */
const digest = workflow({
  description: "Gather notes on a topic and write them up",
  input: z.object({ topic: z.string().min(3).describe("What to digest") }),
  run: async (input, ctx) => await ctx.step("write", async () => `report on ${input.topic}`),
});

export const app = workflowApp({ name: "digest-desk", workflows: { digest } });

/**
 * ── EDIT: what this suite supplies the session. ─────────────────────────
 *
 * The agent is the only required member. `env` is what its tools read as
 * `ctx.env` and nothing is inherited implicitly, so a case declares exactly
 * what the code under evaluation may see. `generate` and `logger` are the two
 * seams a case substitutes; both are typed, which is what lets a shared fixture
 * be declared once rather than inferred at every use.
 */
const lines: string[] = [];
const collecting: Logger = {
  debug: (message) => lines.push(`debug ${message}`),
  info: (message) => lines.push(`info ${message}`),
  warn: (message) => lines.push(`warn ${message}`),
  error: (message) => lines.push(`error ${message}`),
};

const OPTIONS: EvalSessionOptions = {
  agent: support,
  env: { ORDERS_BASE_URL: "https://orders.example" },
  logger: collecting,
};

/** One session per case. The caller owns closing it. */
export async function openCase(options: EvalSessionOptions = OPTIONS): Promise<EvalSession> {
  return await openEvalSession(options);
}

/**
 * ── EDIT: substituting the in-tool LLM call. ────────────────────────────
 *
 * `ctx.generate` inside a tool is a second model call, and a case asserting on
 * what the TOOL did should not pay for one. Naming the type is what makes this
 * one double shared across a suite.
 */
export const fixedGenerate: HostGenerateFn = async () => ({ text: "fixed", object: undefined });

/**
 * ── EDIT: the claim this case makes. ────────────────────────────────────
 *
 * `say` drives one turn and hands back what the agent DID. Asserting on the
 * CALL rather than on a turn index is the rule: how many turns an agent takes
 * to get somewhere is the model's business and it measurably varies.
 */
export async function toolsForFirstTurn(utterance: string): Promise<readonly string[]> {
  const session = await openCase();
  try {
    const turn: EvalTurn = await session.say(utterance);
    const calls: readonly EvalToolCall[] = turn.toolCalls;
    return toolNames(calls);
  } finally {
    await session.close();
  }
}

/**
 * ── EDIT: what a MULTI-TURN case reads. ─────────────────────────────────
 *
 * The readers take the raw event stream, so a case asserts across every turn
 * rather than re-deriving the transcript itself. {@link TURN_ENDS} is the set of
 * event types that terminate one, for a harness walking the stream by hand.
 */
export type Transcript = {
  said: readonly string[];
  calls: readonly EvalToolCall[];
  states: readonly unknown[];
  lastState: unknown;
  custom: readonly unknown[];
  terminators: number;
};

export async function transcriptOf(utterances: readonly string[]): Promise<Transcript> {
  const session = await openCase();
  try {
    const turns: EvalTurn[] = [];
    for (const utterance of utterances) turns.push(await session.say(utterance));
    const events = session.events();
    return {
      said: saidIn(events),
      calls: toolCallsInTurns(turns),
      states: statesIn(events),
      lastState: lastStateIn(events),
      custom: customEventsIn(events, "progress"),
      terminators: events.filter((event) => TURN_ENDS.has(event.type)).length,
    };
  } finally {
    await session.close();
  }
}

/**
 * ── EDIT: reading one CALL rather than one reply. ───────────────────────
 *
 * The turn a mechanism fired in, never turn number two. `describeTurn` and
 * `describeToolCalls` render what happened for a failure message, which is what
 * turns "expected look_up" into something readable.
 */
export function auditLookup(turns: readonly EvalTurn[]): string {
  const turn = turnCalling(turns, "look_up");
  const calls = toolCallsInEvents(turn.events);
  const args = toolArgsIn(calls, "look_up");
  const result = toolResultIn(calls, "look_up");
  const results = toolResultsIn(calls, "look_up");
  return [
    describeTurn(turn),
    describeToolCalls(calls),
    `${args.length} call(s), ${results.length} result(s), last ${JSON.stringify(result)}`,
  ].join("\n");
}

/**
 * ── EDIT: what a keyless run gets. ──────────────────────────────────────
 *
 * The FALLBACK is public policy: a suite that runs without a credential is
 * checking wiring rather than behaviour, and it has to be able to say so.
 * `evalCredentials` is what answers which of the two this machine gets.
 */
const SCRIPT: StubScript = [
  "Let me look that up.",
  { tool: "look_up", args: { order: "W1234" } } satisfies StubStep,
  "Order W1234 shipped yesterday.",
];

export function scriptedSession(): { llm: StubLlm; env: Record<string, string> } {
  const llm = installStubLlm(SCRIPT);
  return { llm, env: { [STUB_LLM_API_KEY_ENV]: "unused" } };
}

export function credentialsFor(): EvalCredentials {
  return evalCredentials(support);
}

/**
 * ── EDIT: the fake speech pair. ─────────────────────────────────────────
 *
 * They register through `registerSttKind`/`registerTtsKind` like any provider,
 * so a harness of your own — one that paces real PCM, or scripts a provider
 * failure — is written the same way rather than against a private hook.
 */
export function fakeSpeech(): {
  providers: StubSpeechProviders;
  stt: ReturnType<typeof createStubSttOpener>;
  tts: ReturnType<typeof createStubTtsOpener>;
  keyEnv: string;
} {
  const providers: StubSpeechProviders = installStubSpeechProviders();
  return {
    providers,
    stt: createStubSttOpener("stub-stt"),
    tts: createStubTtsOpener("stub-tts"),
    keyEnv: STUB_SPEECH_API_KEY_ENV,
  };
}

/** What a harness driving the fake stages directly holds. */
export type SpeechPair = { stt: StubSttSession; tts: StubTtsSession };

/**
 * ── EDIT: an agent that answers by RUNNING code. ────────────────────────
 *
 * The `run_code` builtin REFUSES without an executor off-platform, so a case
 * about such an agent cannot assert the answer at all until a host supplies
 * one.
 */
const VM_OPTIONS: VmRunCodeOptions = { timeoutMs: 5000 };

export function codeRunner(options: VmRunCodeOptions = VM_OPTIONS) {
  return createVmRunCode(options);
}

/**
 * ── EDIT: the TEXT agent, which has no session to fake stages of. ───────
 *
 * `createRuntime` refuses `text: true` by name, so this is a second harness
 * rather than an option on the first. Everything above the model is shared: the
 * turn record is the same {@link EvalTurn} and every reader takes it unchanged.
 */
const TEXT_OPTIONS: EvalTextAgentOptions = { agent: desk };

export async function askDesk(message: string): Promise<EvalTurn> {
  const agent: EvalTextAgent = await openEvalTextAgent(TEXT_OPTIONS);
  try {
    // `send`, where a voice session `say`s — the same turn record either way.
    return await agent.send(message);
  } finally {
    await agent.close();
  }
}

/**
 * ── EDIT: driving a WORKFLOW app. ───────────────────────────────────────
 *
 * The engine here is NOT durable — no journal, no replay, no retry — and a case
 * declared through it may not be reported as covering any of the three. Its
 * `client` is also what a voice session's `workflows` option takes, which is
 * what makes a run-starting TOOL executable in an eval.
 */
const STEP_FETCH: StepFetch | undefined = undefined;
const ENGINE_SPEECH: EvalWorkflowEngineOptions["speech"] = undefined;

const WORKFLOW_OPTIONS: EvalWorkflowsOptions = {
  agent: app,
  stepFetch: STEP_FETCH,
  speech: ENGINE_SPEECH,
};

const RUN_OPTIONS: EvalRunOptions = { timeoutMs: DEFAULT_RUN_TIMEOUT_MS };

export async function digestOf(topic: string): Promise<string> {
  const runs: EvalWorkflows = openEvalWorkflows(WORKFLOW_OPTIONS);
  const run: EvalWorkflowRun<string> = await runs.run(digest, { topic }, RUN_OPTIONS);
  // The two records a run leaves behind. The SLEEP one is the harness admitting
  // what it cannot do: a durable suspension is recorded, never taken.
  const emitted: readonly EvalEmitted[] = run.emitted;
  const slept: readonly EvalSleep[] = run.slept;
  if (emitted.length + slept.length < 0) throw new Error("unreachable");
  return completedOutput(run);
}

export function workflowCredentials(): EvalCredentials {
  return evalWorkflowCredentials(app);
}

/** A voice session whose run-starting tool can really run. */
export async function sessionWithRuns(): Promise<EvalSession> {
  const runs = openEvalWorkflows(WORKFLOW_OPTIONS);
  return await openEvalSession({ ...OPTIONS, workflows: runs.client });
}

/**
 * ── EDIT: the suite, as vitest sees it. ─────────────────────────────────
 *
 * `describeEval` owns the credential gate, the scripted-model fallback and the
 * per-case session, so a case is its assertions and nothing else. `stubReply`
 * is what the scripted model answers when there is no key — the eval still
 * proves the agent boots, tools resolve, and a reply comes back.
 */
const CASE: EvalCaseOptions = { stubReply: "Order W1234 shipped yesterday." };

const SUITE: DescribeEvalOptions = {
  env: { ORDERS_BASE_URL: "https://orders.example" },
  workflowOptions: { stepFetch: STEP_FETCH },
};

export function declareSuite(): void {
  describeEval(
    support,
    (test: EvalTest) => {
      test(
        "looks the order up first",
        async ({ session, mode }: EvalTestContext) => {
          const turn = await session.say("where is order W1234?");
          if (mode === "live" && turn.text === "") throw new Error("said nothing");
          if (!toolNames(turn.toolCalls).includes("look_up")) {
            throw new Error(describeTurn(turn));
          }
        },
        CASE,
      );
    },
    SUITE,
  );
}

/** The same, one mode over: a workflow app has no session at all. */
export function declareWorkflowSuite(): void {
  describeWorkflowEval(
    app,
    (test: EvalWorkflowTest) => {
      test(
        "writes the report",
        async ({ app: runs, mode }: EvalWorkflowTestContext) => {
          const run = await runs.run(digest, { topic: "shipping" });
          if (mode === "live" && run.status !== "completed") {
            throw new Error(`expected completed, got ${run.status}`);
          }
        },
        { live: false } satisfies EvalWorkflowCaseOptions,
      );
    },
    { stepFetch: STEP_FETCH },
  );
}

/**
 * ── EDIT: branching on which model this run got. ────────────────────────
 *
 * Most cases should NOT. Where one must — an assertion only a live model can
 * satisfy — the mode is resolved from the agent AND the case's own overrides,
 * because an override the session honours and the gate ignores announces the
 * wrong answer.
 */
export function modeFor(): { session: EvalMode; workflows: EvalMode; why: string } {
  // Each answers the mode WITH the reason it chose one, so a suite announcing
  // "SCRIPTED" can say which credential it looked for and did not find.
  const session = resolveEvalMode(support);
  const workflows = resolveWorkflowEvalMode(app);
  return { session: session.mode, workflows: workflows.mode, why: session.reason };
}
