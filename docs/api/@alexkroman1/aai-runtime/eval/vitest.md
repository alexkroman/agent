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
function describeEval<Network extends EvalNetwork = never, Client extends WorkflowClient = never>(
   agent: AgentDef, 
   define: (test: EvalTest<Network, Client>) => void, 
   options?: Omit<DescribeEvalOptions, "workflows" | "network"> & {
  network?: Network | (() => Network);
  workflows?: Client | (() => Client);
}
): void;
```

Declare an eval suite for `agent`.

Generic over the suite's `network` and `workflows` only so a case's
`ctx.network` and `ctx.workflowClient` are typed by them (see
[EvalTestContext.network](#network-2)); nobody writes the type arguments, they
are read off `options`.

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

#### Type Parameters

##### Network

`Network` *extends* [`EvalNetwork`](../eval.md#evalnetwork) = `never`

##### Client

`Client` *extends* [`WorkflowClient`](../../aai/index.md#workflowclient) = `never`

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### define

(`test`: [`EvalTest`](#evaltest)\<`Network`, `Client`\>) => `void`

##### options?

`Omit`\<[`DescribeEvalOptions`](#describeevaloptions), `"workflows"` \| `"network"`\> & \{
  `network?`: `Network` \| (() => `Network`);
  `workflows?`: `Client` \| (() => `Client`);
\}

#### Returns

`void`

***

### describeTextEval()

```ts
function describeTextEval(
   agent: AgentDef, 
   define: (test: EvalTextTest) => void, 
   options?: DescribeTextEvalOptions
): void;
```

Declare an eval suite for a TEXT agent.

```ts
import { agent } from "@alexkroman1/aai";
import { toolNames } from "@alexkroman1/aai-runtime/eval";
import { describeTextEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

const agentDef = agent({ name: "Coder", mode: "text" });

describeTextEval(agentDef, (test) => {
  test(
    "reads a file before it edits one",
    async ({ agent: coder }) => {
      const turn = await coder.send("rename `total` to `sum` in cart.ts");
      expect(toolNames(turn.toolCalls)).toContain("read_file");
    },
    { stubReply: [{ tool: "read_file", args: { path: "cart.ts" } }, "Renamed it."] },
  );
});
```

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### define

(`test`: [`EvalTextTest`](#evaltexttest)) => `void`

##### options?

[`DescribeTextEvalOptions`](#describetextevaloptions)

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
`describeEval(def, define, { llm: llm({ provider: "assemblyai", model }) })` on an agent declaring
`anthropic()` announced "SCRIPTED — ANTHROPIC_API_KEY is not set" while
holding the key the run would actually have used. Measured on
`custom-pipeline-agent`: the override was honoured by the session and ignored by
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
wrong one is silent: a `mode: "workflow-app"` agent needs no provider credential, so
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
  network?:   | EvalNetwork
     | (() => EvalNetwork);
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

##### network?

```ts
readonly optional network?: 
  | EvalNetwork
  | (() => EvalNetwork);
```

A fake network for every case — an `evalNetwork(...)`, or a FACTORY
returning one, called afresh for every case and every `AAI_EVAL_REPEAT`
repeat.

It becomes all three fetches a case's code can reach: the global `fetch`
a custom tool calls, the `fetch` the builtins take, and the step fetch a
workflow step (or `sendToChannel`) reads. A request no route answers is
REFUSED and logged; only the live model's own provider hosts pass through,
worked out from the agent's `llm` (in a scripted run, not even those).
The global is swapped for the whole SUITE rather than per case, so an
`onSessionEnd` still running after a case closed (the session waits 10
seconds for it, then stops waiting) is refused into that case's log
rather than reaching the real network.

Keep a route's STATE (rows a fake database holds) in the network's own
`state` (`evalNetwork({ state, routes })`): an instance's log AND state are
rebuilt per case and per repeat, and the case reads it, typed, as
`ctx.network.state`. State a handler keeps in its closure is not reset —
use a factory for that — and state carried from one repeat into the next
makes the second repeat measure the first. Mutually exclusive with
`fetch`, which it replaces.

##### workflowOptions?

```ts
readonly optional workflowOptions?: Omit<EvalWorkflowsOptions, "agent">;
```

***

### DescribeTextEvalOptions

```ts
type DescribeTextEvalOptions = Omit<EvalTextAgentOptions, "agent">;
```

What [describeTextEval](#describetexteval) takes beyond the agent.

***

### EvalCaseOptions

```ts
type EvalCaseOptions = {
  call?: SessionCall | null;
  clientId?: string | null;
  live?: boolean;
  network?:   | EvalNetwork
     | (() => EvalNetwork);
  phone?: string | null;
  scripted?: boolean;
  stubGenerate?: StubScript;
  stubReply?: StubScript;
};
```

What a case gets to say about how it should be run.

#### Properties

##### call?

```ts
readonly optional call?: SessionCall | null;
```

This case's placed phone call, over the suite's — what `sessionContext`
receives as `call`. See `EvalSessionOptions.call`; a call the hook refuses
lands on `session.refused`. `null` is "not a placed call": a calling
agent's refusal of a session no carrier started, inside a suite whose
other cases are all the one call.

##### clientId?

```ts
readonly optional clientId?: string | null;
```

WHO this case's session is, over the suite's own
([DescribeEvalOptions](#describeevaloptions)) — the client id `sessionClientId(ctx)`
answers. See `EvalSessionOptions.clientId`. `null` is "no client id for
this case", whatever the suite set; absent is "the suite's".

Per case because a suite's cases are rarely all the same caller: a
speaker agent's "a device with no client id is refused" case sits beside
twenty that run as the kitchen speaker, and it is written
`{ clientId: null }`.

##### live?

```ts
readonly optional live?: boolean;
```

This case only means something against a live model — it is SKIPPED in stub
mode. Use it for a claim no script can honestly satisfy: a tool the model
has to choose for itself, a refusal, a judgement.

##### network?

```ts
readonly optional network?: 
  | EvalNetwork
  | (() => EvalNetwork);
```

This case's fake network, over the suite's — see
`DescribeEvalOptions.network`. A case needing routes of its own (a
service that answers differently in this one scenario) passes them here.

##### phone?

```ts
readonly optional phone?: string | null;
```

This case's reported phone number, over the suite's. See
`EvalSessionOptions.phone`. `null` is "no number for this case".

##### scripted?

```ts
readonly optional scripted?: boolean;
```

The mirror: this case only means something against a SCRIPT, and is skipped
against a live model.

It is not a symmetry for its own sake — three cases needed it. A gate can
only be observed refusing if something CALLS the gated tool, and a competent
model declines to (measured: `tabletop-rpg-agent`'s game-over route is a tool its own
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
type EvalTest<Network extends EvalNetwork = never, Client extends WorkflowClient = never> = (name: string, body: (ctx: EvalTestContext & [Network] extends [never] ? unknown : {
  network: Network;
} & [Client] extends [never] ? unknown : {
  workflowClient: Client;
}) => Promise<void>, options?: [Network] extends [never] ? EvalCaseOptions : Omit<EvalCaseOptions, "network"> & {
  network?: Network | (() => Network);
}) => void;
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

#### Type Parameters

##### Network

`Network` *extends* [`EvalNetwork`](../eval.md#evalnetwork) = `never`

##### Client

`Client` *extends* [`WorkflowClient`](../../aai/index.md#workflowclient) = `never`

#### Parameters

##### name

`string`

##### body

(`ctx`: [`EvalTestContext`](#evaltestcontext) & \[`Network`\] *extends* \[`never`\] ? `unknown` : \{
  `network`: `Network`;
\} & \[`Client`\] *extends* \[`never`\] ? `unknown` : \{
  `workflowClient`: `Client`;
\}) => `Promise`\<`void`\>

##### options?

\[`Network`\] *extends* \[`never`\] ? [`EvalCaseOptions`](#evalcaseoptions) : `Omit`\<[`EvalCaseOptions`](#evalcaseoptions), `"network"`\> & \{
  `network?`: `Network` \| (() => `Network`);
\}

#### Returns

`void`

***

### EvalTestContext

```ts
type EvalTestContext = {
  mode: EvalMode;
  network: EvalNetwork | undefined;
  session: EvalSession;
  workflowClient: WorkflowClient | undefined;
  workflows: EvalWorkflows | undefined;
};
```

**`Sealed`**

What a case body is handed: its own session, which model it is on, and the
workflow app behind it.

A simulated caller and a model-graded judge are NOT on it: a case that wants
them builds the pair from `session` and `mode` with `evalSimulation` on
`@alexkroman1/aai-runtime/eval/simulate`, a surface versioned on its own.

#### Properties

##### mode

```ts
readonly mode: EvalMode;
```

Which model this run got. A case may branch on it, and most should not.

## The one branch that is always right

**A value a SCRIPT determined may only be asserted under
`mode === "stub"`.** `stubReply` and `stubGenerate` are what make a value
predictable, so pinning one against a live model is pinning the script — and
it presents as the agent misbehaving, which is the expensive part. Three
shipped template evals had it, and each read as a defect in the template
until the script was checked:

- `word-game-agent` asserted `playerSaid: "Is it a zebra crossing?"`, the
  exact remark of a scripted player, in a game whose word is drawn at
  random. Live, "Is it a zebra?" is a perfectly good wrong guess.
- `executive-inbox-agent` pinned `2 closed / 6 queued`, a split decided by
  eight live triage verdicts. A run that found every email worth answering
  failed on "expected [] to have a length of 2".
- `topic-briefing-agent` required a verdict word from a subagent its own
  tool documents as allowed to come back unusable.

So: assert the INVARIANT in both modes — the tool was called, the verdict
and the score agree, nothing was sent before a yes — and put the exact
strings behind the branch.

```ts no-check
test("a wrong guess is relayed without a point", async ({ session, mode }) => {
  const relayed = await play(session);
  // True either way: the player answered and the round stands.
  expect(relayed.playerSaid.length).toBeGreaterThan(0);
  if (relayed.verdict === "wrong") expect(relayed.score).toBe(0);
  // Only a script can pin the words.
  if (mode === "stub") expect(relayed.playerSaid).toBe("Is it a zebra crossing?");
});
```

A case that cannot be written that way wants `{ scripted: true }` instead,
which skips it live rather than weakening it — see
[EvalCaseOptions.scripted](#scripted).

##### network

```ts
readonly network: EvalNetwork | undefined;
```

The fake network every `fetch` of this case went through. Its log holds
THIS case's requests (THIS repeat's, under `AAI_EVAL_REPEAT`), so a case
asserts on `network.calls("textbelt.com")` or
`network.expectNoOutbound(/twilio/)` without filtering out another run's
traffic, and reads its routes' `network.state`.

TYPED BY WHAT WAS PASSED, in the body a case hands [EvalTest](#evaltest): in
a suite given `network` it is exactly that network's type —
`EvalNetwork<{ calls: Map<…> }>` for one built with `state` — so there is
no `undefined` to guard and no cast to reach the state. A case's own
`network` must be of the suite's type, so the type holds for it too. In a
suite given none it is `EvalNetwork | undefined` (this declaration) —
`undefined` at runtime unless the case passed one.

##### session

```ts
readonly session: EvalSession;
```

Open for this case, closed after it.

##### workflowClient

```ts
readonly workflowClient: WorkflowClient | undefined;
```

The client this session's `ctx.workflows` IS: the suite's own
(`describeEval`'s `workflows` — the one its factory built for THIS case
and repeat), else the engine's `workflows.client`, else
`undefined` for an agent that declares no workflows and was given none.

Typed by what the suite passed, in the body a case hands
[EvalTest](#evaltest): a suite whose factory returns a recording client —
`() => createRecordingWorkflows({ workflows: agentDef.workflows })` from
`@alexkroman1/aai/testing`, which records every start and runs nothing —
reads `workflowClient.started("remind")` and seeds the runs `find`
answers with `workflowClient.seed(...)`, typed, with no module-level log
to reset.

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

### EvalTextTest

```ts
type EvalTextTest = (name: string, body: (ctx: EvalTextTestContext) => Promise<void>, options?: EvalCaseOptions) => void;
```

Declare one text eval case. The conversation is opened and closed for it.

#### Parameters

##### name

`string`

##### body

(`ctx`: [`EvalTextTestContext`](#evaltexttestcontext)) => `Promise`\<`void`\>

##### options?

[`EvalCaseOptions`](#evalcaseoptions)

#### Returns

`void`

***

### EvalTextTestContext

```ts
type EvalTextTestContext = {
  agent: EvalTextAgent;
  mode: EvalMode;
};
```

**`Sealed`**

What a text case body is handed: its own conversation and the mode. A
simulated caller is `evalSimulation({ target: agent, … })` on
`@alexkroman1/aai-runtime/eval/simulate`, as for a voice case.

#### Properties

##### agent

```ts
readonly agent: EvalTextAgent;
```

Opened for this case, released after it.

##### mode

```ts
readonly mode: EvalMode;
```

Which model this run got. A case may branch on it, and most should not.

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

**`Sealed`**

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
