# testing/vitest

`@alexkroman1/aai-runtime/testing/vitest` — the vitest-coupled testing door:
everything that INSTALLS or RESTORES, and the eval suites.

A test file imports from two places: `@alexkroman1/aai-runtime/testing` for
every fake and reader that installs nothing, and this subpath for the rest.
One import serves a unit spec and an eval file alike:

- every installer of `@alexkroman1/aai/testing/vitest` (`installStubGateway`,
  `installStubStepFetch`, `installStubTranscribe`, …), each of which arms a fake
  and restores it with `onTestFinished`;
- everything `@alexkroman1/aai-runtime/eval/vitest` provides — the
  `describeEval` / `describeTextEval` / `describeWorkflowEval` suites, the
  session and the readers, the simulated caller and the judge, and the SDK
  stubs a case composes with.

```ts
import type { AgentDef } from "@alexkroman1/aai";
import { describeEval, expectCalled } from "@alexkroman1/aai-runtime/testing/vitest";

declare const agentDef: AgentDef;

describeEval(agentDef, (test) => {
  test(
    "looks the order up before answering",
    async ({ session }) => {
      expectCalled(await session.say("where is order W1234?"), "look_up");
    },
    { stubReply: "Order W1234 shipped yesterday." },
  );
});
```

Every name is a re-export of the SAME declaration as its original subpath,
so ownership does not move: the eval names keep their `eval*` capabilities,
the SDK stubs `eval-stubs`, and the other installers `testing-stubs`.
`vitest` is an OPTIONAL peer dependency, and importing this subpath is what
pulls it; `/testing` and `/eval` stay importable without it.

## Functions

### installStubClientInbox()

```ts
function installStubClientInbox(options?: StubClientInboxOptions): StubClientInbox;
```

Publish a device inbox for `stepNotifyClient`, restored when this test
finishes.

`stubClientInbox` with the bookkeeping done — see it for the call log and how
to make the device answer busy or offline. The usual partner of
[installStubSpeech](../eval/vitest.md#installstubspeech): a step that speaks a notice and pushes it to a
speaker needs both, and each used to cost a `try`/`finally` of its own.

#### Parameters

##### options?

[`StubClientInboxOptions`](../testing.md#stubclientinboxoptions)

#### Returns

[`StubClientInbox`](../testing.md#stubclientinbox)

#### Example

In a test body or a `beforeEach`:
```ts
import { stepNotifyClient } from "@alexkroman1/aai/step";
import { installStubClientInbox } from "@alexkroman1/aai/testing/vitest";

const inbox = installStubClientInbox();
await stepNotifyClient("kitchen", { id: "wrun_1", event: "reminder" });
console.log(inbox.calls[0]?.clientId); // "kitchen"
```

***

### installStubGateway()

```ts
function installStubGateway(replies: string | readonly string[], options?: StubGatewayOptions): StubGatewayCall[];
```

Install a fake LLM gateway as the global `fetch`, and return its call log.

`stubGateway` (`@alexkroman1/aai/testing`) installed for you. Import it under
THIS name — aliasing it to `stubGateway` shadows the uninstalled fake of that
name. A step whose HTTP goes through a published `stepFetch` wants
`stubGatewayRoute` instead; `stubGateway`'s doc has the table.

The calls array is what a spec asserts on, and it is live — a reference taken
before the code under test runs holds every call made after.

**Lifetime is one test**, as it is for any `vi.stubGlobal` under
`unstubGlobals` — which this repo's shared config and `defineAgentTestConfig`
(`@alexkroman1/aai/testing/vite`) both set, so the real `fetch` is back
before the next test. Install per test (the test body or a `beforeEach`);
one installed in `beforeAll` is gone before the first test runs. Without
`unstubGlobals`, `vi.unstubAllGlobals()` is the explicit undo.

#### Parameters

##### replies

`string` \| readonly `string`[]

Completion contents, in order; the last repeats — see
  `stubGateway` in `@alexkroman1/aai/testing`, which this installs.

##### options?

[`StubGatewayOptions`](../testing.md#stubgatewayoptions)

#### Returns

[`StubGatewayCall`](../testing.md#stubgatewaycall)[]

#### Example

```ts no-check
// `no-check`: the step under test is in another file, which is the point.
import { installStubGateway } from "@alexkroman1/aai/testing/vitest";
import { expect, test } from "vitest";
import { summarize } from "./workflows/digest.ts";

test("summarize sends the article", async () => {
  const calls = installStubGateway('{"headline":"Otters use tools"}');
  await summarize("Otters use tools.");
  expect(calls[0]?.prompt).toContain("Otters use tools.");
});
```

***

### installStubReporter()

```ts
function installStubReporter(): StubReporter;
```

Capture what a step narrates and emits, restored when this
test finishes.

`stubReporter` with the bookkeeping done — see it for why `stepReport()` and
`stepEmit()` are separated the way the streams are.

#### Returns

[`StubReporter`](../testing.md#stubreporter)

***

### installStubWorkflows()

```ts
function installStubWorkflows(options?: StubWorkflowsOptions): WorkflowClient;
```

A `ctx.workflows` whose reads answer from one fixture and whose every method
is a `vi.fn`.

`createStubWorkflows` (`@alexkroman1/aai/testing`) is the framework-agnostic
base: it REJECTS every method, so a tool reaching for one the spec did not
stub says so. That is the right default and it is not the shape a spec of a
workflow-driving agent wants, because such a tool reads two or three methods
per call and asserts on `start`. Both shipped workflow templates therefore
opened with the same fifteen lines — a `vi.fn` per method, answering from one
`runs` array — byte-identical apart from the workflow name in `listing`.

**It is on this subpath because `vi.fn` is the content.** The methods have to
be spies: a spec asserts `expect(workflows.start).toHaveBeenCalledWith(def,
input)` and re-points one per test with
`vi.mocked(workflows.lastLine).mockResolvedValue("…")`. A plain-function
version would be a different helper that neither template could use.

**What it does NOT answer is deliberate.** `stream`, `streamTail`, `signal`
and `publicWebhookUrl` fall through to the rejecting base, because a tool
reading a progress channel by hand is the hazard `lastLine` exists to remove
— see `WorkflowClient.lastLine`, where composing `streamTail` + `stream` in
the wrong order waits forever with no error. A spec that really is testing
one of those overrides it, which reads as the deliberate act it is.

Spread it to replace a method for one test: `{ ...installStubWorkflows(), signal }`.

#### Parameters

##### options?

[`StubWorkflowsOptions`](#stubworkflowsoptions)

#### Returns

[`WorkflowClient`](../../aai/index.md#workflowclient)

#### Example

```ts
import { createRunSnapshot, createToolContext } from "@alexkroman1/aai/testing";
import { installStubWorkflows } from "@alexkroman1/aai/testing/vitest";

const workflows = installStubWorkflows({
  names: ["recap"],
  runs: [createRunSnapshot({ workflow: "recap", status: "running" })],
});
const ctx = createToolContext({ workflows });
```

## Type Aliases

### StubWorkflowsOptions

```ts
type StubWorkflowsOptions = {
  lastLine?: unknown;
  names?: readonly string[];
  runId?: string;
  runs?: readonly WorkflowRunSnapshot[];
};
```

What [installStubWorkflows](#installstubworkflows) answers each read with.

Every field has a default, so `installStubWorkflows()` is a client whose reads all
answer "nothing has run" — which is the arm a `*_status` tool branches on
first and the one most specs of one want.

#### Properties

##### lastLine?

```ts
optional lastLine?: unknown;
```

What `lastLine` resolves with. Defaults to `undefined`, which means "the
run has written nothing yet" — the arm a progress tool branches on, and the
reason this has a default rather than being left to reject.

##### names?

```ts
optional names?: readonly string[];
```

Workflow names `listing()` reports, in order — normally the one the agent
under test declares. Defaults to none, i.e. an agent declaring no workflow.

##### runId?

```ts
optional runId?: string;
```

What `start` resolves with. Defaults to `"wrun_stub"`.

##### runs?

```ts
optional runs?: readonly WorkflowRunSnapshot[];
```

The runs `get`, `find` and `recent` answer from — `get` with the first,
the other two with the whole list. One list rather than three, because a
spec asserting what a tool REPORTS is describing one world, and three
fixtures that can disagree about it is a way to write a passing test for a
state the platform cannot produce. Build them with `createRunSnapshot`.

## References

### CallVerdict

Re-exports [CallVerdict](../eval.md#callverdict)

***

### completedOutput

Re-exports [completedOutput](../eval.md#completedoutput)

***

### createRecordingWorkflows

Re-exports [createRecordingWorkflows](../eval/vitest.md#createrecordingworkflows)

***

### createStubSttOpener

Re-exports [createStubSttOpener](../eval.md#createstubsttopener)

***

### createStubTtsOpener

Re-exports [createStubTtsOpener](../eval.md#createstubttsopener)

***

### createVmRunCode

Re-exports [createVmRunCode](../eval.md#createvmruncode)

***

### CriterionVerdict

Re-exports [CriterionVerdict](../eval.md#criterionverdict)

***

### customEventsIn

Re-exports [customEventsIn](../eval.md#customeventsin)

***

### DEFAULT\_MAX\_TURNS

Re-exports [DEFAULT_MAX_TURNS](../eval.md#default_max_turns)

***

### DEFAULT\_RUN\_TIMEOUT\_MS

Re-exports [DEFAULT_RUN_TIMEOUT_MS](../eval.md#default_run_timeout_ms)

***

### describeEval

Re-exports [describeEval](../eval/vitest.md#describeeval)

***

### DescribeEvalOptions

Re-exports [DescribeEvalOptions](../eval/vitest.md#describeevaloptions)

***

### describeTextEval

Re-exports [describeTextEval](../eval/vitest.md#describetexteval)

***

### DescribeTextEvalOptions

Re-exports [DescribeTextEvalOptions](../eval/vitest.md#describetextevaloptions)

***

### describeToolCalls

Re-exports [describeToolCalls](../eval.md#describetoolcalls)

***

### describeTurn

Re-exports [describeTurn](../eval.md#describeturn)

***

### describeWorkflowEval

Re-exports [describeWorkflowEval](../eval/vitest.md#describeworkfloweval)

***

### dialogRefusalPattern

Re-exports [dialogRefusalPattern](../eval/vitest.md#dialogrefusalpattern)

***

### dialogResultSchema

Re-exports [dialogResultSchema](../eval/vitest.md#dialogresultschema)

***

### END\_CALL\_TOOL

Re-exports [END_CALL_TOOL](../eval.md#end_call_tool)

***

### errorsIn

Re-exports [errorsIn](../eval.md#errorsin)

***

### EvalCaseOptions

Re-exports [EvalCaseOptions](../eval/vitest.md#evalcaseoptions)

***

### evalCredentials

Re-exports [evalCredentials](../eval.md#evalcredentials-1)

***

### EvalCredentials

Re-exports [EvalCredentials](../eval.md#evalcredentials)

***

### EvalEmitted

Re-exports [EvalEmitted](../eval.md#evalemitted)

***

### EvalMode

Re-exports [EvalMode](../eval/vitest.md#evalmode)

***

### evalNetwork

Re-exports [evalNetwork](../eval.md#evalnetwork-1)

***

### EvalNetwork

Re-exports [EvalNetwork](../eval.md#evalnetwork)

***

### EvalNetworkOptions

Re-exports [EvalNetworkOptions](../eval.md#evalnetworkoptions)

***

### EvalRequest

Re-exports [EvalRequest](../eval.md#evalrequest)

***

### EvalRequestFilter

Re-exports [EvalRequestFilter](../eval.md#evalrequestfilter)

***

### EvalRoute

Re-exports [EvalRoute](../eval.md#evalroute)

***

### EvalRunOptions

Re-exports [EvalRunOptions](../eval.md#evalrunoptions)

***

### EvalSession

Re-exports [EvalSession](../eval.md#evalsession)

***

### EvalSessionOptions

Re-exports [EvalSessionOptions](../eval.md#evalsessionoptions)

***

### evalSimulation

Re-exports [evalSimulation](../eval.md#evalsimulation)

***

### EvalSimulationContext

Re-exports [EvalSimulationContext](../eval.md#evalsimulationcontext)

***

### EvalSimulationOptions

Re-exports [EvalSimulationOptions](../eval.md#evalsimulationoptions)

***

### EvalSleep

Re-exports [EvalSleep](../eval.md#evalsleep)

***

### EvalTest

Re-exports [EvalTest](../eval/vitest.md#evaltest)

***

### EvalTestContext

Re-exports [EvalTestContext](../eval/vitest.md#evaltestcontext)

***

### EvalTextAgent

Re-exports [EvalTextAgent](../eval.md#evaltextagent)

***

### EvalTextAgentOptions

Re-exports [EvalTextAgentOptions](../eval.md#evaltextagentoptions)

***

### evalTextCredentials

Re-exports [evalTextCredentials](../eval.md#evaltextcredentials)

***

### EvalTextTest

Re-exports [EvalTextTest](../eval/vitest.md#evaltexttest)

***

### EvalTextTestContext

Re-exports [EvalTextTestContext](../eval/vitest.md#evaltexttestcontext)

***

### EvalToolCall

Re-exports [EvalToolCall](../eval.md#evaltoolcall)

***

### EvalTurn

Re-exports [EvalTurn](../eval.md#evalturn)

***

### EvalWorkflowCaseOptions

Re-exports [EvalWorkflowCaseOptions](../eval/vitest.md#evalworkflowcaseoptions)

***

### evalWorkflowCredentials

Re-exports [evalWorkflowCredentials](../eval.md#evalworkflowcredentials)

***

### EvalWorkflowEngineOptions

Re-exports [EvalWorkflowEngineOptions](../eval.md#evalworkflowengineoptions)

***

### EvalWorkflowRun

Re-exports [EvalWorkflowRun](../eval.md#evalworkflowrun)

***

### EvalWorkflows

Re-exports [EvalWorkflows](../eval.md#evalworkflows)

***

### EvalWorkflowsOptions

Re-exports [EvalWorkflowsOptions](../eval.md#evalworkflowsoptions)

***

### EvalWorkflowTest

Re-exports [EvalWorkflowTest](../eval/vitest.md#evalworkflowtest)

***

### EvalWorkflowTestContext

Re-exports [EvalWorkflowTestContext](../eval/vitest.md#evalworkflowtestcontext)

***

### eventsOf

Re-exports [eventsOf](../eval/vitest.md#eventsof)

***

### expectCalled

Re-exports [expectCalled](../eval.md#expectcalled)

***

### expectToolBeforeSpeech

Re-exports [expectToolBeforeSpeech](../eval.md#expecttoolbeforespeech)

***

### HostAgentOptions

Re-exports [HostAgentOptions](../eval.md#hostagentoptions)

***

### HostGenerateFn

Re-exports [HostGenerateFn](../eval.md#hostgeneratefn)

***

### installStubLlm

Re-exports [installStubLlm](../eval.md#installstubllm)

***

### installStubSpeech

Re-exports [installStubSpeech](../eval/vitest.md#installstubspeech)

***

### installStubSpeechProviders

Re-exports [installStubSpeechProviders](../eval.md#installstubspeechproviders)

***

### installStubStepDelegate

Re-exports [installStubStepDelegate](../eval/vitest.md#installstubstepdelegate)

***

### installStubStepFetch

Re-exports [installStubStepFetch](../eval/vitest.md#installstubstepfetch)

***

### installStubTranscribe

Re-exports [installStubTranscribe](../eval/vitest.md#installstubtranscribe)

***

### installStubUploads

Re-exports [installStubUploads](../eval/vitest.md#installstubuploads)

***

### isEvent

Re-exports [isEvent](../eval/vitest.md#isevent)

***

### judgeCall

Re-exports [judgeCall](../eval.md#judgecall)

***

### JudgeCallOptions

Re-exports [JudgeCallOptions](../eval.md#judgecalloptions)

***

### JudgeInput

Re-exports [JudgeInput](../eval.md#judgeinput)

***

### lastStateIn

Re-exports [lastStateIn](../eval.md#laststatein)

***

### lastToolResultIn

Re-exports [lastToolResultIn](../eval.md#lasttoolresultin)

***

### LogContext

Re-exports [LogContext](../eval.md#logcontext)

***

### LogFn

Re-exports [LogFn](../eval.md#logfn)

***

### Logger

Re-exports [Logger](../eval.md#logger-3)

***

### LogLevel

Re-exports [LogLevel](../eval.md#loglevel)

***

### openEvalSession

Re-exports [openEvalSession](../eval.md#openevalsession)

***

### openEvalTextAgent

Re-exports [openEvalTextAgent](../eval.md#openevaltextagent)

***

### openEvalWorkflows

Re-exports [openEvalWorkflows](../eval.md#openevalworkflows)

***

### RecordingWorkflows

Re-exports [RecordingWorkflows](../eval/vitest.md#recordingworkflows)

***

### RecordingWorkflowsOptions

Re-exports [RecordingWorkflowsOptions](../eval/vitest.md#recordingworkflowsoptions)

***

### resolveEvalMode

Re-exports [resolveEvalMode](../eval/vitest.md#resolveevalmode)

***

### resolveWorkflowEvalMode

Re-exports [resolveWorkflowEvalMode](../eval/vitest.md#resolveworkflowevalmode)

***

### RunCodeExecutor

Re-exports [RunCodeExecutor](../eval.md#runcodeexecutor)

***

### runCodeIn

Re-exports [runCodeIn](../eval.md#runcodein)

***

### runCodeOutput

Re-exports [runCodeOutput](../eval.md#runcodeoutput)

***

### saidIn

Re-exports [saidIn](../eval.md#saidin)

***

### simulateCall

Re-exports [simulateCall](../eval.md#simulatecall)

***

### SimulateCallOptions

Re-exports [SimulateCallOptions](../eval.md#simulatecalloptions)

***

### SimulatedCall

Re-exports [SimulatedCall](../eval.md#simulatedcall)

***

### SimulatedCaller

Re-exports [SimulatedCaller](../eval.md#simulatedcaller)

***

### SimulatedTurn

Re-exports [SimulatedTurn](../eval.md#simulatedturn)

***

### SimulationMetrics

Re-exports [SimulationMetrics](../eval.md#simulationmetrics)

***

### SimulationTarget

Re-exports [SimulationTarget](../eval.md#simulationtarget)

***

### statesIn

Re-exports [statesIn](../eval.md#statesin)

***

### StepUsage

Re-exports [StepUsage](../eval.md#stepusage)

***

### SttError

Re-exports [SttError](../eval.md#stterror)

***

### SttEvents

Re-exports [SttEvents](../eval.md#sttevents)

***

### SttOpener

Re-exports [SttOpener](../eval.md#sttopener)

***

### SttOpenOptions

Re-exports [SttOpenOptions](../eval.md#sttopenoptions)

***

### SttSession

Re-exports [SttSession](../eval.md#sttsession)

***

### SttTurnMeta

Re-exports [SttTurnMeta](../eval.md#sttturnmeta)

***

### STUB\_LLM\_API\_KEY\_ENV

Re-exports [STUB_LLM_API_KEY_ENV](../eval.md#stub_llm_api_key_env)

***

### STUB\_SPEECH\_API\_KEY\_ENV

Re-exports [STUB_SPEECH_API_KEY_ENV](../eval.md#stub_speech_api_key_env)

***

### stubGatewayRoute

Re-exports [stubGatewayRoute](../eval/vitest.md#stubgatewayroute-1)

***

### StubGatewayRoute

Re-exports [StubGatewayRoute](../eval/vitest.md#stubgatewayroute)

***

### StubLlm

Re-exports [StubLlm](../eval.md#stubllm)

***

### StubScript

Re-exports [StubScript](../eval.md#stubscript)

***

### StubSpeech

Re-exports [StubSpeech](../eval/vitest.md#stubspeech)

***

### StubSpeechOptions

Re-exports [StubSpeechOptions](../eval/vitest.md#stubspeechoptions)

***

### StubSpeechProviders

Re-exports [StubSpeechProviders](../eval.md#stubspeechproviders)

***

### StubStep

Re-exports [StubStep](../eval.md#stubstep)

***

### StubStepDelegate

Re-exports [StubStepDelegate](../eval/vitest.md#stubstepdelegate)

***

### StubStepFetch

Re-exports [StubStepFetch](../eval/vitest.md#stubstepfetch)

***

### StubSttSession

Re-exports [StubSttSession](../eval.md#stubsttsession)

***

### StubTranscribe

Re-exports [StubTranscribe](../eval/vitest.md#stubtranscribe)

***

### StubTranscribeOptions

Re-exports [StubTranscribeOptions](../eval/vitest.md#stubtranscribeoptions)

***

### StubTtsSession

Re-exports [StubTtsSession](../eval.md#stubttssession)

***

### StubUploads

Re-exports [StubUploads](../eval/vitest.md#stubuploads)

***

### StubUploadsOptions

Re-exports [StubUploadsOptions](../eval/vitest.md#stubuploadsoptions)

***

### toolArgsIn

Re-exports [toolArgsIn](../eval.md#toolargsin)

***

### toolCallsInEvents

Re-exports [toolCallsInEvents](../eval.md#toolcallsinevents)

***

### toolCallsInTurns

Re-exports [toolCallsInTurns](../eval.md#toolcallsinturns)

***

### toolNames

Re-exports [toolNames](../eval.md#toolnames)

***

### toolResultIn

Re-exports [toolResultIn](../eval.md#toolresultin)

***

### toolResultsIn

Re-exports [toolResultsIn](../eval.md#toolresultsin)

***

### transcriptOf

Re-exports [transcriptOf](../eval.md#transcriptof)

***

### TtsError

Re-exports [TtsError](../eval.md#ttserror)

***

### TtsEvents

Re-exports [TtsEvents](../eval.md#ttsevents)

***

### TtsOpener

Re-exports [TtsOpener](../eval.md#ttsopener)

***

### TtsOpenOptions

Re-exports [TtsOpenOptions](../eval.md#ttsopenoptions)

***

### TtsSession

Re-exports [TtsSession](../eval.md#ttssession)

***

### TtsWordTiming

Re-exports [TtsWordTiming](../eval.md#ttswordtiming)

***

### TURN\_ENDS

Re-exports [TURN_ENDS](../eval.md#turn_ends)

***

### turnCalling

Re-exports [turnCalling](../eval.md#turncalling)

***

### Unsubscribe

Re-exports [Unsubscribe](../eval.md#unsubscribe)

***

### VmRunCodeOptions

Re-exports [VmRunCodeOptions](../eval.md#vmruncodeoptions)
