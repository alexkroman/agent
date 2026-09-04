// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 20.
 *
 * A template's spec as it was authored at epoch 20 — build the context a tool
 * body is handed, drive a tool through the agent's own table, unwrap a gated
 * result, ask a schema what it accepts, script the two model seams, fake the
 * four published slots a step reaches the outside world through, and drive a
 * workflow body without an engine. It must keep compiling for as long as epoch
 * 19 is advertised as supported.
 *
 * ## What moved, and why epoch 20 survives it
 *
 * Epoch 21 ADDED `routeStepFetch` and its two types. Additive: no existing
 * signature moved, and nothing a spec already called behaves differently.
 *
 * What the addition replaces is a COMPOSITION callers wrote by hand — route the
 * model leg, then decide what an unrecognised request means. {@link handler}
 * below is that hand-written version, which is the whole point of freezing it:
 * thirteen sites across seven templates looked like this at epoch 20, and they
 * have to keep compiling whether or not they are ever converted.
 *
 * Nothing here names `routeStepFetch`, `StepRoute` or `StepUnmatched`.
 *
 * ## The `/vitest` half is the same capability, and it is REFERENCED
 *
 * `installStubGateway`, `installStubStepFetch`, `installStubUploads`,
 * `installStubSpeech`, `installStubTranscribe`, `installStubReporter` and
 * `mockWorkflows` come from `@alexkroman1/aai/testing/vitest`, which is a second
 * SUBPATH of this one contract rather than a second contract: what is there is
 * only the installation of what is here, split off so the test-runner dependency
 * is opt-in. So they are epoch 20's promise too and they are frozen here.
 *
 * That costs nothing, because this file is COMPILED and never executed. An
 * `install*` reaches for `onTestFinished`, which only a running test has — but
 * what a caller depends on is its SIGNATURE, and naming it in a call the
 * compiler checks is the whole of what freezing it means. Not one function
 * below is ever invoked by anything; the evidence is that they all type-check.
 *
 * ## Where a break lands
 *
 * The three shapes are frozen from three different sides, deliberately — the
 * rule holds for `v20-slots.ts` too, and the examples named here are the ones
 * this half carries:
 *
 * - **Options bags** ({@link CTX}, {@link CLIENT}) are written by the caller, so
 *   a field REMOVED or made required reddens at the literal and a field added
 *   does not. That is the direction a fake's surface actually moves in.
 * - **Result shapes** ({@link WorkflowCtxRecorder}, {@link TestToolContext}, …)
 *   are read, so a field or a method going away reddens where it is read.
 * - **Call logs** ({@link RecordedStep}, {@link RecordedSleep},
 *   {@link SentEvent}) are the assertions themselves. They are the half worth
 *   freezing hardest: a fake that stopped recording a field does not fail a
 *   spec, it makes an assertion unwritable — and every spec that already wrote
 *   one is where that shows up.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 20 has to be dropped with a reason.
 *
 * ## The example is two files
 *
 * The four published step slots and the reporter live in `v20-slots.ts`, which
 * is the same frozen example in a second module — the file outgrew the 500-line
 * source cap and the section banner was the seam it already had. This one keeps
 * the name because the gate reads `v<N>.ts` by name (`fixturePath` in
 * `scripts/_api-contracts-tree.mjs`); the two do NOT import each other, and
 * nothing imports either. What freezes an epoch is that the whole package still
 * COMPILES, and both halves are in the same program — so a reader following the
 * epoch reads both files, and a break lands in whichever one names the symbol.
 */

import {
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createWorkflowCtx,
  deployedAgent,
  ok,
  okPosition,
  type ProjectFiles,
  parseSchemaInput,
  parseToolInput,
  type RecordedSleep,
  type RecordedStep,
  type RunSnapshotOverrides,
  runTool,
  type SentEvent,
  type StubDelegate,
  type StubDelegateCall,
  type StubDelegateReply,
  type StubDelegateRoute,
  type StubGenerate,
  type StubGenerateCall,
  type StubGenerateReply,
  type StubGenerateRoute,
  schemaInputIssues,
  stubDelegate,
  stubGenerate,
  type TestToolContext,
  type ToolBearingAgent,
  type ToolContextOverrides,
  type ToolRunner,
  toolInputIssues,
  toolOf,
  toolRunner,
  WORKFLOW_CTX_NOW,
  type WorkflowCtxOptions,
  type WorkflowCtxRecorder,
} from "../../../sdk/testing.ts";
import { type MockWorkflowsOptions, mockWorkflows } from "../../../sdk/testing-vitest.ts";

// ── The context a tool body is handed ────────────────────────────────────

/**
 * A scripted `ctx.generate`, keyed by the system prompt the node carries.
 *
 * The route is written as a FUNCTION rather than as a fixed reply, which is
 * what a grader asked once per document needs: it can read the call and shift
 * its own answer. `object` is required and `text` defaults to the JSON of it —
 * a schema call's text IS the stringified object in production, so a fake that
 * left it empty would differ from the real host in the one place a caller might
 * read.
 */
const GRADER: StubGenerateRoute = (call: StubGenerateCall): StubGenerateReply =>
  call.prompt.includes("refund") ? { object: { score: 1 } } : "no";

/** The model a tool reasons with. */
export function scriptModel(): StubGenerate {
  return stubGenerate({ "You grade retrieved documents.": GRADER });
}

/**
 * A scripted `ctx.delegate`, keyed by subagent name.
 *
 * `subagent` is the DEF rather than its name, which is what lets a spec assert
 * the budget and the tool surface the parent handed over — the two things a
 * delegation gets wrong, and neither of them recoverable from a name.
 */
const RESEARCHER: StubDelegateRoute = (call: StubDelegateCall): StubDelegateReply => ({
  text: `${call.subagent.name} looked into: ${call.task}`,
  steps: 3,
});

/** The two subagents a fan-out asks. */
export function scriptDelegation(): StubDelegate {
  return stubDelegate({ researcher: RESEARCHER, "fact-checker": "Both claims check out." });
}

/**
 * The `ctx.workflows` a tool that starts or reads runs is given.
 *
 * Every method it does NOT name rejects, which is the property worth having: a
 * tool that reached for a second one is a finding rather than an `undefined`
 * three assertions later.
 */
export function toolWorkflows() {
  return createStubWorkflows({
    find: () => Promise.resolve([createRunSnapshot({ status: "running" })]),
  });
}

/**
 * The context a tool body is handed, with the defaults epoch 20 filled.
 *
 * The overrides are annotated rather than inferred because the ANNOTATION is
 * what the type exists for: `ToolContextOverrides` admits an explicit
 * `undefined` per field where `Partial<ToolContext>` would not, so a spec
 * holding a `string | undefined` passes it straight through instead of writing
 * the conditional spread this repo's own gates count as debt.
 */
export function context(): TestToolContext {
  const model = scriptModel();
  const desk = scriptDelegation();
  const overrides: ToolContextOverrides = {
    sessionId: "sess_1",
    env: { ASSEMBLYAI_API_KEY: "test-key" },
    generate: model.generate,
    delegate: desk.delegate,
    workflows: toolWorkflows(),
  };
  return createToolContext(overrides);
}

/**
 * What the tool put on the wire.
 *
 * An event the runtime would have DROPPED — over the payload cap, an over-long
 * name, no JSON form — is not in here either, which is the reason to read the
 * recorder rather than a spy: the assertion is about what the browser sees.
 */
export function firstSent(ctx: TestToolContext): SentEvent | undefined {
  return ctx.sent[0];
}

// ── Driving the tools ────────────────────────────────────────────────────

/**
 * The def a DEPLOYED agent runs.
 *
 * `tools` is deliberately not passed here: it is an `import.meta.glob` written
 * at the SPEC's own call site, expanded against that file's directory, and a
 * pattern hoisted anywhere else expands against the wrong one. A project whose
 * prompt is a file and whose tools are inline is the case this shape covers.
 *
 * The parameter's type is read off the contract's own signature rather than
 * imported from the `agent` capability — a frozen example is evidence about ONE
 * promise, and naming a neighbouring surface would let a break there redden this
 * file and misattribute the finding.
 */
type Authored = Parameters<typeof deployedAgent>[0];

/** The lowering a spec applies when its runner registers no Vite plugin. */
export function deployed(authored: Authored): Authored {
  const project: ProjectFiles = { systemPrompt: "You take pizza orders." };
  return deployedAgent(authored, project);
}

/** What the model is told a tool is for. */
export function toolDescription(agent: ToolBearingAgent, name: string): string {
  return String(toolOf(agent, name).description);
}

/** One call, unbound — the shape for a spec that drives a single tool once. */
export async function callOnce(agent: ToolBearingAgent, ctx: TestToolContext): Promise<unknown> {
  // No arguments, so the context takes their place: a no-argument tool is
  // common, and the `{}` those calls used to be obliged to pass sat between the
  // two values a reader actually cares about.
  return await runTool(agent, "view_order", ctx);
}

/** The bound runner every template spec opens with. */
export function bind(agent: ToolBearingAgent): ToolRunner {
  return toolRunner(agent);
}

/** Driving a tool through the agent's own table, epoch 20. */
export async function callTool(agent: ToolBearingAgent, args: Record<string, unknown>) {
  const run: ToolRunner = bind(agent);
  // `ok` fails at the CALL quoting a refusal, rather than letting a cast read
  // `undefined` off it three assertions later.
  return ok(await run("view_order", args));
}

/** The gated shape: a result plus where the dialog landed. */
export async function callGated(agent: ToolBearingAgent) {
  return okPosition(await bind(agent)("confirm_change"));
}

// ── Asking a schema what it accepts ──────────────────────────────────────

/** Reading a tool's own input schema, without restating it. */
export function inputOf(agent: ToolBearingAgent, raw: unknown) {
  return parseToolInput(agent, "view_order", raw);
}

/**
 * The negative half, which is the assertion actually worth writing: the schema
 * is the one thing standing between an LLM's untyped call and the tool body.
 */
export function refusedInput(agent: ToolBearingAgent, raw: unknown) {
  return toolInputIssues(agent, "view_order", raw);
}

/**
 * The same pair over a schema the caller HOLDS, which is what a workflow's
 * `input` is — there is no tool to look it up on.
 *
 * The type comes off the contract's signature for the reason {@link Authored}
 * does: `StandardSchemaV1` belongs to the schema vendor, not to this promise.
 */
type InputSchema = Parameters<typeof parseSchemaInput>[0];

/** What the workflow's own input schema made of a form submission. */
export async function workflowInput(schema: InputSchema, raw: unknown): Promise<{ url: string }> {
  return await parseSchemaInput<{ url: string }>(schema, raw, "the digest workflow");
}

/** And why it refused one. */
export async function workflowInputIssues(schema: InputSchema, raw: unknown) {
  return await schemaInputIssues(schema, raw, "the digest workflow");
}

// ── The workflow body, without an engine ─────────────────────────────────

/**
 * What the recorder answers the body with.
 *
 * `now` is pinned to the contract's own instant rather than to `Date.now`,
 * which is the same rule a real run follows: a body that read the clock would
 * take a different branch on replay, and a fixture that read it would not be a
 * fixture.
 */
const CTX: WorkflowCtxOptions = {
  runId: "wrun_test",
  workflow: "recap",
  runSteps: true,
  now: WORKFLOW_CTX_NOW,
  results: { fetchPage: "<p>hi</p>" },
  hooks: { "recap:keep": true },
};

/** A workflow BODY driven without the replay engine. */
export function bodyCtx(): WorkflowCtxRecorder {
  return createWorkflowCtx(CTX);
}

/** Which steps the body reached, in the order it reached them. */
export function stepsReached(ctx: WorkflowCtxRecorder): string[] {
  return ctx.steps.map((step: RecordedStep) => step.name);
}

/**
 * The wait the body asked for and did NOT take.
 *
 * `label` rather than a duration: a body with two waits is telling you WHICH one
 * it reached, which is the fact a case about a schedule is actually about.
 */
export function firstWait(ctx: WorkflowCtxRecorder): RecordedSleep | undefined {
  return ctx.slept[0];
}

/** And the tokens it parked on. */
export function tokensWaited(ctx: WorkflowCtxRecorder): string[] {
  return ctx.waited;
}

// ── Fixtures for a workflow client a tool talks to ───────────────────────

/**
 * A finished run, the right arm of the union, without a cast.
 *
 * The overrides are annotated so `output` is checked against the workflow's own
 * return type — the discriminated shape is what stops a fixture claiming
 * `completed` with nothing to show for it.
 */
const COMPLETED: RunSnapshotOverrides<{ summary: string }> = {
  status: "completed",
  output: { summary: "done" },
};

/** Fixtures for a workflow client a tool talks to. */
export function snapshot() {
  return createRunSnapshot(COMPLETED);
}

/** The narration a page reads back off a run. */
export function progress() {
  return createProgressStream(["Fetching the page…", "Summarizing…"]);
}

/**
 * The whole client in one line, for a tool whose reads all succeed.
 *
 * Every field has a default, so a spec names only the one its assertion is
 * about — which is what separates this from {@link toolWorkflows}, where the
 * point is that an unnamed method REJECTS.
 */
const CLIENT: MockWorkflowsOptions = {
  runs: [createRunSnapshot({ status: "running" })],
  names: ["recap"],
  runId: "wrun_stub",
  lastLine: { note: "done" },
};

/** The mocked client a tool spec passes as `ctx.workflows`. */
export function workflowClient() {
  return mockWorkflows(CLIENT);
}
