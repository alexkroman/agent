// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:eval` epoch 3.
 *
 * An eval file as a TEMPLATE author writes one — which is what this capability
 * is for. Its consumers do not implement anything here; they CALL
 * `describeEval`, drive turns with `say()`, and read the run back through the
 * event readers. So this is the caller side, written the way it was authored at
 * epoch 3, and it must keep compiling for as long as that epoch is advertised as
 * supported.
 *
 * ## Three halves, because the capability has three
 *
 * 1. **The voice suite** — `describeEval` over an `agent()`, factored the way a
 *    suite of any size gets factored: a registrar typed {@link EvalTest}, a case
 *    body typed {@link EvalTestContext}, and one shared
 *    {@link DescribeEvalOptions} bag carrying the four seams.
 * 2. **The workflow-app suite** — `describeWorkflowEval` over a
 *    `workflowApp()`, which has no session at all: its product is a run, and the
 *    case reads what that run RETURNED, narrated, emitted and asked to sleep.
 * 3. **A harness with no runner around it** — the stages and the scripted model
 *    assembled by hand. `installFakeSpeech` and `installStubLlm` are published
 *    precisely so that is writable against the same seams rather than against a
 *    private hook, and the two openers are published so a harness that paces its
 *    own input can open one directly.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * Epoch 4 ADDED five names — `toolNames` and `describeToolCalls` on the readers,
 * `describeTurn`, `callsIn` and `turnCalling` over a sequence of turns — plus one
 * method, `EvalSession.sayAll`. Every one of them was hand-rolled in the shipped
 * template evals first, several byte-identically, which is what said they were
 * the harness's concepts rather than any template's.
 *
 * Nothing in epoch 3 stops compiling, which is what makes this a retain: an
 * export ADDED to a subpath breaks no importer, and a method added to a type an
 * eval CONSUMES breaks no call site. The file below still spells the three
 * hand-rolled readers out longhand, and still drives a caller's lines one at a
 * time where epoch 4 says `sayAll`, which is exactly how an epoch-3 eval was
 * written. It is deliberately left that way — an epoch example that adopted the
 * newer names would stop being an epoch-3 example.
 *
 * **The direction that WOULD break is a name coming OFF `/eval` or `/eval/vitest`,
 * or a signature narrowing under one of the calls below** — `say()` no longer
 * answering an `EvalTurn`, `toolResultIn` demanding a schema, `EvalTestContext`
 * losing `workflows`, `completedOutput` taking something other than a run,
 * `FakeSpeech.stt` ceasing to be what `agent()` takes, `StubStep` losing its tool
 * form, `EvalWorkflows.settle` refusing a def. Each reddens this file
 * immediately, which is the whole reason the CALLER side is the one worth
 * freezing for a capability nobody implements.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 3 has to be dropped with a reason.
 */

import { agent, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import {
  completedOutput,
  createFakeSttOpener,
  createFakeTtsOpener,
  createVmRunCode,
  customEventsIn,
  type EvalCredentials,
  type EvalEmitted,
  type EvalRunOptions,
  type EvalSession,
  type EvalSessionOptions,
  type EvalSleep,
  type EvalToolCall,
  type EvalTurn,
  type EvalWorkflowRun,
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  evalCredentials,
  evalWorkflowCredentials,
  FAKE_SPEECH_API_KEY_ENV,
  type FakeSpeech,
  type FakeSttSession,
  type FakeTtsSession,
  installFakeSpeech,
  installStubLlm,
  lastStateIn,
  openEvalSession,
  openEvalWorkflows,
  STUB_LLM_API_KEY_ENV,
  type StepFetch,
  type StubLlm,
  type StubScript,
  type StubStep,
  saidIn,
  statesIn,
  TURN_ENDS,
  toolArgsIn,
  toolCallsIn,
  toolResultIn,
  toolResultsIn,
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
 * ── EDIT: your own agent. ────────────────────────────────────────────────
 *
 * Declared inline so the example needs no `agent.ts` beside it; a real eval
 * imports the agent under test (`import agentDef from "./agent.ts"`, or
 * `virtual:aai/agent` in a template).
 */
const DESK_PROMPT = "Help the caller with an order. Confirm before changing anything.";

const agentDef = agent({
  name: "Order Desk",
  systemPrompt: DESK_PROMPT,
  greeting: "Order desk — how can I help?",
});

/** What the agent pushes to the page, for the state readers below. */
const ProjectedOrder = z.object({ reference: z.string(), placed: z.boolean() });

/** The digest a workflow app returns, for the workflow half. */
const digest = workflow({
  description: "Summarize an order",
  input: z.object({ reference: z.string() }),
  run: (input: { reference: string }) => ({ headline: `order ${input.reference}` }),
});

const workflowApp = agent({
  name: "Order Digest",
  page: "static",
  workflows: { digest },
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});

/** No runner in an authoring example — a case's own claim, spelled out. */
function insist(ok: boolean, why: string): void {
  if (!ok) throw new Error(why);
}

/**
 * ── The three readers epoch 3 had no export for. ─────────────────────────
 *
 * Frozen as they were written: every shipped eval carried some spelling of
 * these, which is what epoch 4's `toolNames`, `callsIn` and `turnCalling`
 * replaced. Left longhand on purpose — see the module doc.
 */
const named = (calls: readonly EvalToolCall[]): string[] => calls.map((call) => call.name);
const allCalls = (turns: readonly EvalTurn[]): readonly EvalToolCall[] =>
  turns.flatMap((turn) => turn.toolCalls);
const turnWith = (turns: readonly EvalTurn[], tool: string): EvalTurn | undefined =>
  turns.find((turn) => turn.toolCalls.some((call) => call.name === tool));

/**
 * A caller's lines, one at a time — the fourth thing epoch 3 spelled out, and
 * the reason a helper takes an {@link EvalSession} rather than a case context:
 * the harness at the bottom of this file drives the same way with no `test`
 * around it.
 */
async function drive(session: EvalSession, lines: readonly string[]): Promise<EvalTurn[]> {
  const turns: EvalTurn[] = [];
  for (const line of lines) turns.push(await session.say(line));
  return turns;
}

/** One scripted move, and the script it belongs to. Reused by the harness below. */
const STAGE_CALL: StubStep = { tool: "stage_cancellation", args: { reference: "W1234" } };
const STAGE_SCRIPT: StubScript = [STAGE_CALL, "Staged."];

/**
 * A case's own options, built once rather than written out at each `test(…)`.
 *
 * Choose the script so the case's assertions still hold: a stub run is only
 * worth having because the case really executes against it.
 */
const stagingCase: EvalCaseOptions = { stubReply: STAGE_SCRIPT };

/**
 * One case body, lifted out of the registrar — which is what names
 * {@link EvalTestContext}, and what a suite does as soon as two cases share
 * setup.
 */
async function staged({ session, mode, workflows }: EvalTestContext): Promise<void> {
  const mode3: EvalMode = mode;
  insist(mode3 === "live" || mode3 === "stub", "a case is told which model it got");
  insist(workflows === undefined || workflows.client !== undefined, "the workflow seam");

  const turns = await drive(session, ["I want to cancel order W1234", "Yes, go ahead"]);
  const staging = turnWith(turns, "stage_cancellation");
  insist(
    staging !== undefined,
    `tools called: [${named(allCalls(turns)).join(", ")}]; said: ${turns.at(-1)?.text}`,
  );
  insist(staging?.completed === true, "the staging reply was not cancelled");

  // The readers, over one turn and over the whole call.
  const calls = toolCallsIn(staging?.events ?? []);
  insist(named(calls).includes("stage_cancellation"), "the staged call is on that turn");
  const args = toolArgsIn(calls, "stage_cancellation", z.object({ reference: z.string() }));
  insist(args[0]?.reference === "W1234", "the reference the caller gave");
  const result = toolResultIn(calls, "stage_cancellation", z.object({ state: z.string() }));
  insist(result.state === "awaitingConfirmation", "staged, not committed");
  insist(toolResultsIn(session.toolCalls(), "stage_cancellation").length > 0, "at least one");

  // What the caller was told, and what the page was shown.
  insist(saidIn(session.events()).length >= 2, "the greeting is a real turn");
  insist(session.said().length >= 2, "and it is in the run-wide view");
  const view = lastStateIn(session.events(), ProjectedOrder);
  insist(view?.reference === "W1234", "the page shows the order");
  insist(statesIn(session.events(), ProjectedOrder).length > 0, "at least one frame");
  insist(customEventsIn(session.events(), "wind_down").length === 0, "no nudge yet");
  insist(TURN_ENDS.has("reply.completed"), "the terminator set is published");
  insist(session.id.length > 0, "a tool correlates a run with this");
}

/**
 * A family of cases registered by a helper — the shape that names
 * {@link EvalTest}. A suite big enough to split across files passes the
 * registrar around; a suite of one nests a closure and never names the type.
 */
function registerDeskCases(test: EvalTest): void {
  test("stages a change and reads it back before committing", staged, stagingCase);
  test(
    "declines to commit until the caller confirms",
    async ({ session }) => {
      const turns = await drive(session, ["cancel order W1234"]);
      insist(turns.length === 1, "one line said is one turn back");
      insist(
        !named(allCalls(turns)).includes("commit_cancellation"),
        `committed unasked: [${named(allCalls(turns)).join(", ")}]`,
      );
    },
    // No script can honestly satisfy "the model declined on its own", so this
    // one is skipped in stub mode rather than weakened.
    { live: true },
  );
}

/** ── EDIT: the seams your cases need. ───────────────────────────────────── */
const vmOptions: VmRunCodeOptions = {
  timeoutMs: 2000,
  // Every entry is a capability grant into the evaluated context.
  globals: { REFERENCE: "W1234" },
};

/** A step's HTTP, answered in memory so no case reaches a stranger's server. */
const offline: StepFetch = (url) =>
  Promise.resolve(
    new Response(JSON.stringify({ url, ok: true }), {
      headers: { "content-type": "application/json" },
    }),
  );

/**
 * The four seams a case fills, plus the engine the session's `ctx.workflows`
 * runs on — one bag a whole suite shares, which is what names
 * {@link DescribeEvalOptions}.
 */
const deskOptions: DescribeEvalOptions = {
  env: { ORDER_API_BASE: "https://orders.example.test" },
  runCode: createVmRunCode(vmOptions),
  fetch: () => Promise.resolve(new Response("{}")),
  toolTimeoutMs: 60_000,
  workflowOptions: { stepFetch: offline, timeoutMs: 20_000 },
};

/** The suite, as `describeEval` registers one. */
export function registerVoiceCases(): void {
  describeEval(agentDef, registerDeskCases, deskOptions);
}

/**
 * ── The workflow half. ───────────────────────────────────────────────────
 *
 * Readers over the two records a run leaves behind. A `sleep()` here is
 * RECORDED and never taken, so what a case can assert is that the body asked and
 * under which label.
 */
const scheduled = (slept: readonly EvalSleep[]): string[] =>
  slept.map((sleep) => `${sleep.label}=${String(sleep.duration)}`);
const chunksOn = (emitted: readonly EvalEmitted[], namespace: string): readonly unknown[] =>
  emitted.filter((entry) => entry.namespace === namespace).map((entry) => entry.chunk);

/** Per-run knobs, named once — a correlation key and a budget. */
const perRun: EvalRunOptions = { key: "caller-42", timeoutMs: 30_000 };

/**
 * Every run this app started, and one of them settled again by id — the half a
 * VOICE case needs, because there the run was started by a tool and the case
 * never saw its id come back.
 */
async function settleAgain(app: EvalWorkflows, runId: string): Promise<void> {
  const all = await app.runs();
  insist(all.length > 0, "the app remembers what it started");
  const again = await app.settle(runId, digest);
  insist(again.completed, "settling a run twice is the same answer");
}

/** One workflow case body — {@link EvalWorkflowTestContext}, factored the same way. */
async function digested({ app, mode }: EvalWorkflowTestContext): Promise<void> {
  insist(mode === "live" || mode === "stub", "a workflow case is told its mode too");
  const run: EvalWorkflowRun<{ headline: string }> = await app.run(
    digest,
    { reference: "W1234" },
    perRun,
  );
  // The error first, so a failed run names its own reason.
  insist(run.error === undefined, `the run failed: ${run.error}`);
  const output = completedOutput(run);
  insist(output.headline.includes("W1234"), "the body's own return value");
  insist(run.key === perRun.key, "the correlation key the caller named");
  insist(scheduled(run.slept).length === 0, "no durable wait was asked for");
  insist(chunksOn(run.emitted, "progress").length === 0, "and nothing was emitted");
  insist(
    run.reported.every((line) => line.trim() !== ""),
    "a narrated line is never blank",
  );
  await settleAgain(app, run.runId);
}

/** Only against real providers — the workflow half's one case option. */
const liveOnly: EvalWorkflowCaseOptions = { live: true };

/** The workflow registrar — {@link EvalWorkflowTest}, the sibling of `EvalTest`. */
function registerDigestCases(test: EvalWorkflowTest): void {
  test("digests an order and narrates on the way", digested);
  test(
    "digests an order the caller really placed",
    async ({ app }) => {
      const run = await app.run(digest, { reference: "W9999" }, { key: "caller-43" });
      insist(completedOutput(run).headline.length > 0, "a live digest says something");
    },
    liveOnly,
  );
}

/** The workflow half of the same capability. */
export function registerWorkflowCases(): void {
  describeWorkflowEval(workflowApp, registerDigestCases, {
    stepFetch: offline,
    timeoutMs: 30_000,
  });
}

/** The credential gates, which decide whether either suite measures anything. */
export function gates(): {
  voice: EvalCredentials;
  workflows: EvalCredentials;
  mode: EvalMode;
  workflowMode: EvalMode;
} {
  const voice: EvalCredentials = evalCredentials(agentDef, { ASSEMBLYAI_API_KEY: "k" });
  // A workflow app declares its credentials in `requiredEnv`, so it is a
  // different question and a different gate — see `resolveWorkflowEvalMode`.
  const workflows: EvalCredentials = evalWorkflowCredentials(workflowApp, {
    ASSEMBLYAI_API_KEY: "k",
  });
  insist(voice.ready === (voice.missing.length === 0), "ready means nothing is missing");
  insist(voice.ready ? voice.reason === undefined : voice.reason !== undefined, "a skip says why");
  insist(workflows.env.ASSEMBLYAI_API_KEY === "k", "the gate hands back what it found");
  return {
    voice,
    workflows,
    mode: resolveEvalMode(agentDef).mode,
    workflowMode: resolveWorkflowEvalMode(workflowApp).mode,
  };
}

/**
 * ── A harness of your own. ───────────────────────────────────────────────
 *
 * The same drive with no vitest suite around it. `describeEval` is a convenience
 * over exactly this, and both doors are part of the promise: the driving half
 * stays runner-agnostic, which is why `openEvalSession` and `openEvalWorkflows`
 * are on `/eval` and the suite is on `/eval/vitest`.
 *
 * The stub model and the two fake stages are published for the same reason —
 * a harness assembles the agent it drives out of them, exactly as `describeEval`
 * does, rather than reaching for a private hook.
 */
export async function runWithoutVitest(): Promise<readonly string[]> {
  const stub: StubLlm = installStubLlm(STAGE_SCRIPT);
  const speech: FakeSpeech = installFakeSpeech();
  // Assembled by hand, which is where a credential goes missing: both fakes
  // resolve one through the registry exactly as a real provider would.
  const providerEnv = { ...evalCredentials(agentDef).env, ...speech.env, ...stub.env };
  insist(providerEnv[FAKE_SPEECH_API_KEY_ENV] !== undefined, "the fake stages resolve one too");
  insist(providerEnv[STUB_LLM_API_KEY_ENV] !== undefined, "and so does the scripted model");

  // The agent this harness drives: the fake stages and the scripted model where
  // a deployed agent names real ones.
  const wired = agent({
    name: "Order Desk (own harness)",
    systemPrompt: DESK_PROMPT,
    greeting: "Order desk — how can I help?",
    stt: speech.stt,
    tts: speech.tts,
    llm: stub.llm,
  });

  const appOptions: EvalWorkflowsOptions = {
    agent: workflowApp,
    env: { ASSEMBLYAI_API_KEY: "k" },
    stepFetch: offline,
  };
  const app = openEvalWorkflows(appOptions);
  const options: EvalSessionOptions = {
    agent: wired,
    providerEnv,
    runCode: createVmRunCode(vmOptions),
    // The seam that makes a run-starting tool executable at all.
    workflows: app.client,
  };
  const session: EvalSession = await openEvalSession(options);
  try {
    const turns = await drive(session, ["cancel order W1234"]);
    insist(turns.length === 1, "one line said is one turn back");
    insist(
      allCalls(turns).every((call) => call.name.length > 0),
      "every call a turn carries is named",
    );
    return session.said();
  } finally {
    await session.close();
    await app.close();
    speech.release();
    stub.release();
  }
}

/**
 * The two fake stages driven DIRECTLY, with no session over them.
 *
 * This is the seam the barrel's own comment is about: the openers register like
 * any provider, so a harness that paces real PCM — or scripts a provider failure
 * — opens one by hand and reads what came back out, rather than asking for a
 * private hook to do it with.
 */
export async function paceOneUtterance(): Promise<{
  heard: readonly string[];
  spoken: readonly string[];
}> {
  const control = new AbortController();
  const open = { apiKey: "unused-by-a-fake", sampleRate: 16_000, signal: control.signal };
  const heard: string[] = [];

  const sttOpener = createFakeSttOpener("harness-stt");
  const stream = await sttOpener.open(open);
  stream.on("partial", (text) => heard.push(`~${text}`));
  stream.on("final", (text) => heard.push(text));
  // A real client's frames would go in here; the fake takes them and drops them.
  stream.sendAudio(new Int16Array(160));
  const inbound: FakeSttSession | undefined = sttOpener.last();
  inbound?.partial("cancel order");
  inbound?.commit("cancel order W1234");

  const ttsOpener = createFakeTtsOpener("harness-tts");
  let done = false;
  const speaker = await ttsOpener.open(open);
  speaker.on("done", () => {
    done = true;
  });
  speaker.sendText("Staged.");
  speaker.flush();
  const outbound: FakeTtsSession | undefined = ttsOpener.last();
  insist(done, "a flush ends the turn and forwards no audio");

  const spoken = outbound?.spoken ?? [];
  await stream.close();
  await speaker.close();
  control.abort();
  return { heard, spoken };
}
