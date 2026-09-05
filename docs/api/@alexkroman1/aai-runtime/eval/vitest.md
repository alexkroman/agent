# eval/vitest

`@alexkroman1/aai-runtime/eval/vitest` — the eval suite, as vitest sees it.

Everything here either INSTALLS something or OWNS a lifetime, which is the
repo's rule for what belongs on a runner-flavoured subpath: `describeEval`
registers a suite, opens a session per case and closes it afterwards, and
decides whether this run has a live model or a scripted one. `vitest` is an
OPTIONAL peer dependency, so importing this module is what pulls it in — the
driving half (`@alexkroman1/aai-runtime/eval`) stays runner-agnostic and can
be used from any harness.

## Functions

### describeEval()

```ts
function describeEval(
   agent: AgentDef, 
   define: (test: EvalTest) => void, 
   options?: DescribeEvalOptions
): void;
```

Declare an eval suite for `agent`.

```ts no-check
describeEval(agentDef, (test) => {
  test(
    "offers to take an order",
    async ({ session }) => {
      const turn = await session.say("hi, what can you do?");
      expect(turn.text).toMatch(/order/i);
    },
    { stubReply: "I can take an order for you." },
  );
});
```

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### define

(`test`: [`EvalTest`](#evaltest)) => `void`

##### options?

[`DescribeEvalOptions`](#describeevaloptions)

#### Returns

`void`

***

### describeWorkflowEval()

```ts
function describeWorkflowEval(
   agent: AgentDef, 
   define: (test: EvalWorkflowTest) => void, 
   options?: Omit<EvalWorkflowsOptions, "agent">
): void;
```

Declare an eval suite for a workflow app.

The signature mirrors `describeEval` down to the two things a LINTER decides —
the callback parameter is named `test` (`noMisplacedAssertion` matches the
callee identifier) and a case body takes a DESTRUCTURED context
(`noDoneCallback` reads the first positional parameter of an async test
callback as jest's `done`). Do not tidy either.

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### define

(`test`: [`EvalWorkflowTest`](#evalworkflowtest)) => `void`

##### options?

`Omit`\<[`EvalWorkflowsOptions`](../eval.md#evalworkflowsoptions), `"agent"`\>

#### Returns

`void`

***

### resolveEvalMode()

```ts
function resolveEvalMode(
   agent: AgentDef, 
   hostEnv?: Record<string, string | undefined>, 
   overrides?: {
  llm?: LlmProvider;
}
): {
  mode: EvalMode;
  reason: string;
};
```

Live if this machine can be, stub if it cannot — unless a caller has said
which it wants.

`AAI_REQUIRE_EVAL` is for a pipeline that means to MEASURE: with it set, a
missing credential is a failure instead of a quiet downgrade to a wiring
check. `AAI_EVAL_STUB` is the opposite instruction, and CI wants it —
a required check must not start spending tokens the day a key reaches its
environment, and must not become a flaky gate on a live model's behaviour.

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### hostEnv?

`Record`\<`string`, `string` \| `undefined`\>

##### overrides?

What the CASE overrides, which decides the credential question with it.

Without this the mode was read off the AGENT alone, so
`describeEval(def, define, { llm: assemblyAILlm() })` on an agent declaring
`anthropic()` announced "SCRIPTED — ANTHROPIC_API_KEY is not set" while
holding the key the run would actually have used. Measured on
`pipeline-simple`: the override was honoured by the session and ignored by
the gate, so a case could not be run live at all.

###### llm?

[`LlmProvider`](../../aai/index.md#llmprovider)

#### Returns

```ts
{
  mode: EvalMode;
  reason: string;
}
```

##### mode

```ts
mode: EvalMode;
```

##### reason

```ts
reason: string;
```

***

### resolveWorkflowEvalMode()

```ts
function resolveWorkflowEvalMode(agent: AgentDef, hostEnv?: Record<string, string | undefined>): {
  mode: EvalMode;
  reason: string;
};
```

[resolveEvalMode](#resolveevalmode) for a WORKFLOW app, whose credentials are a different
question.

Split rather than folded in because the two gates read different fields and the
wrong one is silent: a `page: "static"` agent needs no provider credential, so
`evalCredentials` reports every workflow app ready and a keyless run goes LIVE
— then every case fails on a 401 three layers down. `evalWorkflowCredentials`
reads `requiredEnv`, which is the only thing a workflow app declares its
credentials in.

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### hostEnv?

`Record`\<`string`, `string` \| `undefined`\>

#### Returns

```ts
{
  mode: EvalMode;
  reason: string;
}
```

##### mode

```ts
mode: EvalMode;
```

##### reason

```ts
reason: string;
```

## Type Aliases

### DescribeEvalOptions

```ts
type DescribeEvalOptions = Omit<EvalSessionOptions, "agent"> & {
  workflowOptions?: Omit<EvalWorkflowsOptions, "agent">;
};
```

What [describeEval](#describeeval) takes beyond the agent.

The session options, plus `workflowOptions` for the engine it opens per case
when the agent declares `workflows`. That second one is not symmetry for its
own sake: a workflow-starting tool's STEPS make provider calls, and the only
honest way to evaluate which tool the desk reached for — without paying for
five gateway calls and a real web search per case, and without a 429 failing
the run outright because a step's `maxRetries` is inert here — is to script
the step's HTTP while leaving the SESSION's model live. Both templates that
hand off to a run had to install that inside the case body, which worked only
because the engine publishes nothing when nobody passed one.

#### Type Declaration

##### workflowOptions?

```ts
readonly optional workflowOptions?: Omit<EvalWorkflowsOptions, "agent">;
```

***

### EvalCaseOptions

```ts
type EvalCaseOptions = {
  live?: boolean;
  scripted?: boolean;
  stubGenerate?: StubScript;
  stubReply?: StubScript;
};
```

What a case gets to say about how it should be run.

#### Properties

##### live?

```ts
readonly optional live?: boolean;
```

This case only means something against a live model — it is SKIPPED in stub
mode. Use it for a claim no script can honestly satisfy: a tool the model
has to choose for itself, a refusal, a judgement.

##### scripted?

```ts
readonly optional scripted?: boolean;
```

The mirror: this case only means something against a SCRIPT, and is skipped
against a live model.

It is not a symmetry for its own sake — three cases needed it. A gate can
only be observed refusing if something CALLS the gated tool, and a competent
model declines to (measured: `solo-rpg`'s game-over route is a tool its own
prompt forbids unprompted; a dispatcher calls `resources_get_available`
first and never trips the busy-unit refusal; a `visit_webpage` at a private
address is the SSRF screen's own case and a live model sensibly refuses to
try). Without this marker each cost a red live run and got weakened.

##### stubGenerate?

```ts
readonly optional stubGenerate?: StubScript;
```

What a SCRIPTED `ctx.generate` answers with — its OWN script, walked by its
own cursor.

Separate from [EvalCaseOptions.stubReply](#stubreply) because `ctx.generate`
resolves a model INSTANCE of its own, in parallel with the turn's: one
script would need element 0 to be the turn's first move and the first
`generate` answer simultaneously. A tool that reasons with a model — a
grader, a planner, a rewriter — is the shape this exists for, and two
shipped templates' central tools are exactly that. For the schema overload,
write the object as the JSON string the model would have returned.

##### stubReply?

```ts
readonly optional stubReply?: StubScript;
```

What a SCRIPTED model does when this suite runs without a key — one entry
per model call, the last line repeating. A string is a line the agent says;
`{ tool, args }` is a tool call, which is what makes a stub run worth having
for an agent that HAS tools:

`no-check`: the fence is one FIELD of this type, and its only compilable
reading is a labelled statement inside a block — it would type-check
whatever the field were called, so checking it asserts nothing about
[EvalCaseOptions.stubReply](#stubreply). Kept as a fragment deliberately, not
because it cannot compile: a `no-check` that would pass is unclaimed
headroom, and this one would pass for the wrong reason.

```ts no-check
{ stubReply: [{ tool: "look_up", args: { orderId: "W1234" } }, "It shipped."] }
```

Choose it so the case's own assertions still hold: the point of a stub run
is that the case really executes, and a stub the case then fails against
measures nothing.

***

### EvalMode

```ts
type EvalMode = "live" | "stub";
```

How the suite is running, and why.

***

### EvalTest

```ts
type EvalTest = (name: string, body: (ctx: EvalTestContext) => Promise<void>, options?: EvalCaseOptions) => void;
```

Declare one eval case. The session is opened for it and closed after it.

Two things about this signature are decided by a LINTER rather than by
taste, both A/B'd against Biome 2.5 and both invisible until a user's own
project lights up red on a file the SDK told them to write:

- **The parameter is named `test`.** `noMisplacedAssertion` matches on the
  CALLEE IDENTIFIER and nothing else, so an `expect` inside `evalTest(…)` is
  an error while the identical body inside `test(…)` is fine.
- **The body takes a DESTRUCTURED context, not the session positionally.**
  `noDoneCallback` reads the first parameter of an async test callback as
  jest's `done`, so `async (session) => …` is an error; `async ({ session })
  => …` is not — and it is vitest's own fixture shape, which is what a reader
  already expects.

#### Parameters

##### name

`string`

##### body

(`ctx`: [`EvalTestContext`](#evaltestcontext)) => `Promise`\<`void`\>

##### options?

[`EvalCaseOptions`](#evalcaseoptions)

#### Returns

`void`

***

### EvalTestContext

```ts
type EvalTestContext = {
  mode: EvalMode;
  session: EvalSession;
  workflows: EvalWorkflows | undefined;
};
```

What a case body is handed: its own session, and which model it is on.

#### Properties

##### mode

```ts
readonly mode: EvalMode;
```

Which model this run got. A case may branch on it, and most should not.

##### session

```ts
readonly session: EvalSession;
```

Open for this case, closed after it.

##### workflows

```ts
readonly workflows: EvalWorkflows | undefined;
```

The workflow app behind this session's `ctx.workflows`, for an agent that
declares workflows — `undefined` for one that does not.

Opened per case and closed after it, and it is what makes a tool calling
`ctx.workflows.start` runnable at all: the real client the runtime would
build cannot start an untransformed body. A case reads the run its tool
started with `workflows.settle(runId)`.

The engine under it is NOT durable — see `eval/workflow-engine.ts` before
writing a claim about a run.

***

### EvalWorkflowCaseOptions

```ts
type EvalWorkflowCaseOptions = {
  live?: boolean;
};
```

What a workflow case gets to say about how it should be run.

#### Properties

##### live?

```ts
readonly optional live?: boolean;
```

This case only means something against real providers — it is SKIPPED in
stub mode.

Reach for it when a step MUST reach the far side for the claim to mean
anything: a transcript that has to be of the audio, a summary that has to
be of the page. A case that can be scripted should be, because a scripted
run is what a pipeline with no key can still gate on.

***

### EvalWorkflowTest

```ts
type EvalWorkflowTest = (name: string, body: (ctx: EvalWorkflowTestContext) => Promise<void>, options?: EvalWorkflowCaseOptions) => void;
```

Declare one workflow eval case. The app is opened for it and closed after it.

#### Parameters

##### name

`string`

##### body

(`ctx`: [`EvalWorkflowTestContext`](#evalworkflowtestcontext)) => `Promise`\<`void`\>

##### options?

[`EvalWorkflowCaseOptions`](#evalworkflowcaseoptions)

#### Returns

`void`

***

### EvalWorkflowTestContext

```ts
type EvalWorkflowTestContext = {
  app: EvalWorkflows;
  mode: EvalMode;
};
```

What a workflow case body is handed.

#### Properties

##### app

```ts
readonly app: EvalWorkflows;
```

Opened for this case, closed after it.

##### mode

```ts
readonly mode: EvalMode;
```

Which mode this run got.

Unlike a voice case, a workflow case is EXPECTED to branch on it: it is what
decides whether to install a fake for a provider a step would otherwise
really dial.
