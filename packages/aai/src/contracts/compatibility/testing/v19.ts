// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 19.
 *
 * A template's spec as it was authored at epoch 19 — build the context a tool
 * body is handed, drive a tool through the agent's own table, unwrap a gated
 * result, ask a schema what it accepts, script the two model seams, fake the
 * four published slots a step reaches the outside world through, and drive a
 * workflow body without an engine. It must keep compiling for as long as epoch
 * 19 is advertised as supported.
 *
 * ## What moved, and why epoch 19 survives it
 *
 * Epoch 20 ADDED `routeStepFetch` and its two types. Additive: no existing
 * signature moved, and nothing a spec already called behaves differently.
 *
 * What the addition replaces is a COMPOSITION callers wrote by hand — route the
 * model leg, then decide what an unrecognised request means. {@link handler}
 * below is that hand-written version, which is the whole point of freezing it:
 * thirteen sites across seven templates looked like this at epoch 19, and they
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
 * is opt-in. So they are epoch 19's promise too and they are frozen here.
 *
 * That costs nothing, because this file is COMPILED and never executed. An
 * `install*` reaches for `onTestFinished`, which only a running test has — but
 * what a caller depends on is its SIGNATURE, and naming it in a call the
 * compiler checks is the whole of what freezing it means. Not one function
 * below is ever invoked by anything; the evidence is that they all type-check.
 *
 * ## Where a break lands
 *
 * The three shapes are frozen from three different sides, deliberately:
 *
 * - **Options bags** ({@link SPEECH}, {@link PROVIDER}, {@link UPLOADS},
 *   {@link CTX}, {@link CLIENT}, {@link REFUSED}) are written by the caller, so
 *   a field REMOVED or made required reddens at the literal and a field added
 *   does not. That is the direction a fake's surface actually moves in.
 * - **Result shapes** ({@link StubUploads}, {@link StubTranscribe},
 *   {@link StubReporter}, {@link WorkflowCtxRecorder}, …) are read, so a field
 *   or a method going away reddens where it is read.
 * - **Call logs** ({@link StubGatewayCall}, {@link StubSpeechCall},
 *   {@link StubTranscribeCall}, {@link RecordedStep}, {@link RecordedSleep},
 *   {@link SentEvent}, {@link StubEmitted}) are the assertions themselves. They
 *   are the half worth freezing hardest: a fake that stopped recording a field
 *   does not fail a spec, it makes an assertion unwritable — and every spec that
 *   already wrote one is where that shows up.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 19 has to be dropped with a reason.
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
  STUB_SPEECH_PCM_BYTES,
  type StubDelegate,
  type StubDelegateCall,
  type StubDelegateReply,
  type StubDelegateRoute,
  type StubEmitted,
  type StubGateway,
  type StubGatewayCall,
  type StubGatewayOptions,
  type StubGatewayRoute,
  type StubGenerate,
  type StubGenerateCall,
  type StubGenerateReply,
  type StubGenerateRoute,
  type StubReporter,
  type StubSpeech,
  type StubSpeechCall,
  type StubSpeechOptions,
  type StubStepAnswer,
  type StubStepFetch,
  type StubStepRequest,
  type StubTranscribe,
  type StubTranscribeCall,
  type StubTranscribeFailure,
  type StubTranscribeLeg,
  type StubTranscribeOptions,
  type StubUpload,
  type StubUploads,
  type StubUploadsOptions,
  type StubUploadWrite,
  schemaInputIssues,
  stubDelegate,
  stubGateway,
  stubGatewayRoute,
  stubGenerate,
  stubReporter,
  stubSpeech,
  stubStepFetch,
  stubStepInfo,
  stubTranscribe,
  stubUploads,
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
import {
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
  type MockWorkflowsOptions,
  mockWorkflows,
} from "../../../sdk/testing-vitest.ts";

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
 * The context a tool body is handed, with the defaults epoch 19 filled.
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

/** Driving a tool through the agent's own table, epoch 19. */
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

// ── The outside world a step reaches ─────────────────────────────────────

/**
 * A refusal the gateway stages by STATUS rather than by minting an error.
 *
 * `retry-after` is the field that makes it worth staging at all: a fake that
 * threw the SDK's own error would be asserting the retryable-versus-terminal
 * classification the spec is trying to test.
 */
const REFUSED: StubGatewayOptions = { status: 429, headers: { "retry-after": "2" } };

/**
 * The hand-written composition — epoch 19's only way to fake two far sides.
 *
 * A model leg, then a throw for anything it does not recognise. Epoch 20's
 * `routeStepFetch` is this function; keeping it here is what proves an epoch-19
 * spec still compiles.
 */
export function handler(model: StubGatewayRoute): (r: StubStepRequest) => StubStepAnswer {
  return (request) => {
    const answered = model.route(request);
    if (answered === undefined) {
      throw new Error(`unexpected step request: ${request.method} ${request.url}`);
    }
    return answered;
  };
}

/** Publishing that handler, epoch 19. */
export function installWorld(replies: readonly string[]): {
  model: StubGatewayRoute;
  fetched: StubStepFetch;
} {
  const model = stubGatewayRoute(replies);
  return { model, fetched: stubStepFetch(handler(model)) };
}

/** The same, with the unwinding left to the runner. */
export function installWorldForThisTest(replies: readonly string[]): StubStepFetch {
  return installStubStepFetch(handler(stubGatewayRoute(replies, REFUSED)));
}

/** The global-fetch gateway, for a spec with no published slot. */
export function installGlobalGateway(reply: string): StubGateway {
  return stubGateway([reply]);
}

/** And its `/vitest` half, which hands back the call log directly. */
export function installGlobalGatewayForThisTest(reply: string): StubGatewayCall[] {
  return installStubGateway([reply], REFUSED);
}

/**
 * What the model was ASKED, decoded.
 *
 * `prompt` and `system` separately, because reading them off the raw request
 * means asserting against the serialized `model` and `temperature` too — which
 * one eval did, and was really testing its own request builder.
 */
export function askedFor(gateway: StubGateway): StubGatewayCall | undefined {
  return gateway.calls[0];
}

// ── The four published slots ─────────────────────────────────────────────

/** A finished recording, and one that is still arriving. */
const RECORDING: StubUpload = {
  bytes: new Uint8Array([0, 0]),
  name: "call.wav",
  type: "audio/wav",
  complete: true,
};

/**
 * The state a step polling an upload has to handle.
 *
 * A body that treats a stalled size as the end returns a transcript of most of
 * a recording and reports success, and a spec cannot catch that without an
 * incomplete upload to hand it.
 */
const ARRIVING: StubUpload = { bytes: new Uint8Array([0]), complete: false };

/**
 * Writes are OPT-IN, which is what makes the pair readable as an assertion: a
 * read-only store cannot accept one, so `writes` staying empty is the same fact
 * as the step never having tried.
 */
const UPLOADS: StubUploadsOptions = { writable: true, idPrefix: "up_test" };

/** The store, unwound by hand. */
export function makeUploads(): StubUploads {
  return stubUploads({ up_1: RECORDING, up_2: ARRIVING }, UPLOADS);
}

/** The store, unwound by the runner. */
export function installUploads(): StubUploads {
  return installStubUploads({ up_1: RECORDING, up_2: ARRIVING }, UPLOADS);
}

/**
 * What a step stored, read back synchronously.
 *
 * Outside the published slot on purpose: a spec asserting on bytes should not
 * have to `await readUpload` through the very seam it is testing.
 */
export function wroteWav(store: StubUploads, id: string): StubUploadWrite | undefined {
  const written = store.read(id);
  return written?.type === "audio/wav" ? written : undefined;
}

/**
 * Silence, at the length the contract names.
 *
 * Naming the constant rather than a number is the point: nothing downstream of
 * a step LISTENS, so the only thing a spec can assert about synthesized audio is
 * how much of it there is, and a literal here would be a spec asserting its own
 * arithmetic.
 */
const SPEECH: StubSpeechOptions = { pcmBytes: STUB_SPEECH_PCM_BYTES };

/** The synthesizer, unwound by hand. */
export function makeSpeech(): StubSpeech {
  return stubSpeech(SPEECH);
}

/** The synthesizer, unwound by the runner. */
export function installSpeech(): StubSpeech {
  return installStubSpeech(SPEECH);
}

/**
 * What the step asked to be said, and in whose voice.
 *
 * The voice is the field worth asserting: a wrong voice id is a SILENT failure
 * in production — the service accepts the socket and refuses in band — so the
 * only place it can be caught is here.
 */
export function spoken(call: StubSpeechCall): string {
  return `${call.voice}/${call.language ?? "auto"}: ${call.text}`;
}

/** A rate limit on ONE leg, which is the case a retry has to survive. */
const RATE_LIMITED: StubTranscribeFailure = { leg: "submit", status: 429, retryAfterSeconds: 2 };

/**
 * The provider, answering in memory.
 *
 * `pendingPolls` is what makes a POLL loop testable at all: a job that is
 * finished on the first read never exercises the branch the loop exists for.
 */
const PROVIDER: StubTranscribeOptions = {
  text: ["Hello there.", "And the rest."],
  durationSec: 12,
  pendingPolls: 1,
  failure: RATE_LIMITED,
};

/** The provider, unwound by hand. */
export function makeProvider(): StubTranscribe {
  return stubTranscribe(PROVIDER);
}

/** The provider, unwound by the runner. */
export function installProvider(): StubTranscribe {
  return installStubTranscribe(PROVIDER);
}

/** Which leg one request was. */
function legOf(call: StubTranscribeCall): StubTranscribeLeg {
  return call.leg;
}

/**
 * The legs the step really walked, in order.
 *
 * The assertion this exists for is "upload once, submit once, poll until done" —
 * a body that re-uploaded on every retry passes every other check in a spec and
 * shows up only here.
 */
export function legsWalked(provider: StubTranscribe): StubTranscribeLeg[] {
  return provider.calls.map(legOf);
}

// ── What the step narrates ───────────────────────────────────────────────

/** The reporter, unwound by hand. */
export function narration(): StubReporter {
  return stubReporter();
}

/** The reporter, unwound by the runner. */
export function installNarration(): StubReporter {
  return installStubReporter();
}

/**
 * The chunks one stream carried.
 *
 * `emitted` is kept apart from `lines` the way the streams are, so a spec
 * asserting a chunk never has to filter the sentences out of it — and a page
 * depending on the SHAPE of those chunks has nowhere else to see them.
 */
export function chunksOn(reported: StubReporter, namespace: string): StubEmitted[] {
  return reported.emitted.filter((chunk) => chunk.namespace === namespace);
}

/**
 * The step's own attempt, so a body's DEGRADE-on-the-last-attempt branch is
 * reachable.
 *
 * Outside a run `stepInfo()` answers `undefined`, which a body reads as "not
 * retrying" — so the branch that exists precisely for the case that goes wrong
 * was the branch no test could enter.
 */
export function onLastAttempt(): { restore: () => void } {
  return stubStepInfo({ attempt: 3, maxAttempts: 3, name: "transcribeSegment" });
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
