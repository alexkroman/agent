# testing

`@alexkroman1/aai-runtime/testing` — driving an agent's own machinery from a
spec: a DURABLE workflow run, and a TEXT agent turn.

The one thing an agent author could not test. A workflow's steps are ordinary
exported functions and its declaration is a value, so both have always been
reachable from a vitest file; the BODY takes a `ctx` only an engine
constructs. `@alexkroman1/aai/testing`'s `createWorkflowContext` gives it one that
records — which is the right tool for asserting what a body ASKED FOR, and
says outright that it is not a durability test — and this gives it the real
engine, over the memory journal, so a spec can assert that a run slept,
resumed, retried, was answered, and survived a dead worker.

```ts
import { workflow } from "@alexkroman1/aai";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";

const approve = workflow({
  description: "Hold a draft until a reviewer answers.",
  run: async (_input, ctx) => await ctx.waitFor<{ approved: boolean }>("approval:1"),
});

const run = await runWorkflow(approve, { draft: "…" }, { name: "approve" });
console.log(run.status); // "running" — parked on the reviewer

await run.signal("approval:1", { approved: true });
console.log(run.status); // "completed"
```

## The TEXT half

`scriptedTextModel` and `runTextAgent` are the same idea one mode over.
`createTextAgent` takes a pre-resolved `LanguageModel` and says outright that
tests are the majority use of that field, and there was nothing published to
put in it — so every caller wrote the provider shape out by hand and cast it,
and each copy re-derived the `finish` frame's shape (the one whose bare-string
spelling silently stops every tool from running). The script is a step —
what the model says, what it calls — and the agent underneath is the real one.

```ts
import { agent } from "@alexkroman1/aai";
import { runTextAgent } from "@alexkroman1/aai-runtime/testing";

const run = await runTextAgent(
  agent({ name: "Desk", text: true, systemPrompt: "Be brief." }),
  "where is order 7?",
  { script: [{ text: "It shipped yesterday." }] },
);
console.log(run.text); // "It shipped yesterday."
```

## Why it is on the RUNTIME rather than beside `createWorkflowContext`

`@alexkroman1/aai` is the shared core and imports no sibling package — a hard
boundary this repo checks with `konsistent`, and one the engine sits on the
far side of. The engine, the journal and `createInProcessWorkflowEngine` are
`@alexkroman1/aai-runtime`'s, so a helper that runs a real one has to live
here. The split a template sees is therefore: `@alexkroman1/aai/testing` for
the CONTEXT (no journal, one walk, everything recorded), this for the ENGINE
(a journal, real replays, real suspensions).

## Runner-agnostic, deliberately

Nothing here installs a global or owns a lifetime a runner has to unwind —
the driver injects its own dispatcher, so no timer is ever armed — which is
this repo's rule for what may stay off a `/vitest` subpath. It works from any
harness.

Exports are enumerated explicitly (no `export *`) so the public surface is
deliberate: a new symbol in one of these modules does not ship as public API
until it is added here.

## Functions

### runTextAgent()

```ts
function runTextAgent(
   def: AgentDef, 
   input: string | readonly ModelMessage[], 
   options: RunTextAgentOptions
): Promise<TextAgentTestRun>;
```

Run one turn of `def` against `script`, and hand back what it did.

`def` must declare `text: true` — `createTextAgent` refuses a voice agent by
name, and this makes no exception, so a spec cannot accidentally measure an
agent whose `greeting` and voice tuning are being silently dropped.

#### Parameters

##### def

[`AgentDef`](../aai/index.md#agentdef)

The agent definition, exactly as a deployment runs it.

##### input

`string` \| readonly `ModelMessage`[]

The conversation, or a string standing for one user message.

##### options

[`RunTextAgentOptions`](#runtextagentoptions)

#### Returns

`Promise`\<[`TextAgentTestRun`](#textagenttestrun)\>

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { runTextAgent } from "@alexkroman1/aai-runtime/testing";

const desk = agent({ name: "Desk", text: true, systemPrompt: "Be brief." });

const run = await runTextAgent(desk, "where is order 7?", {
  script: [
    { text: "Let me check.", toolCalls: [{ name: "look_up", input: { id: "7" } }] },
    { text: "It shipped yesterday." },
  ],
});

console.log(run.text); // "Let me check.It shipped yesterday."
console.log(run.toolCalls[0]?.name, run.toolCalls[0]?.args);
```

#### Throws

whatever ended the model stream, rather than reporting a turn that
  silently produced nothing. A scripted stream fails only when something under
  it is broken, and a harness that swallowed that would report the broken path
  as an agent with nothing to say.

***

### runWorkflow()

```ts
function runWorkflow<P extends ToolInputSchema, R>(
   def: WorkflowDef<P, R>, 
   input: Record<string, unknown>, 
   options?: RunWorkflowOptions
): Promise<WorkflowTestHandle<R>>;
```

Start `def` with `input` and drive it until it finishes or parks.

Resolves a handle carrying the run's status, output and journaled steps, with
four methods for the things only a durable run can do — end a wait, answer a
hook, survive a restart, and shut down.

The input is validated against `def.input` when the declaration has one, which
is what `ctx.workflows.start` does on every real path: a body is written
against a validated input, so handing it an unvalidated one tests a call that
cannot happen.

#### Type Parameters

##### P

`P` *extends* [`ToolInputSchema`](../aai/index.md#toolinputschema)

##### R

`R`

What the body returns, taken from the declaration.

#### Parameters

##### def

[`WorkflowDef`](../aai/index.md#workflowdef)\<`P`, `R`\>

##### input

`Record`\<`string`, `unknown`\>

##### options?

[`RunWorkflowOptions`](#runworkflowoptions)

#### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

#### Example

```ts
import { workflow } from "@alexkroman1/aai";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";

const digest = workflow({
  description: "Summarize a link, then file it once it has settled.",
  run: async (input, ctx) => {
    const text = await ctx.step("read", () => `the page at ${String(input.url)}`);
    await ctx.sleep("settle", 10_000);
    return { text, filedAt: await ctx.step("file", () => "ok") };
  },
});

const run = await runWorkflow(digest, { url: "https://example.com/a" }, {
  name: "digest",
});

// It slept rather than blocking, and said for how long.
console.log(run.status, run.wakeAt);

// And it resumes off the journal without re-running what it already did.
await run.advanceSleep();
console.log(run.status, run.output, run.deliveries);
```

***

### scriptedTextModel()

```ts
function scriptedTextModel(steps: readonly ScriptedTextStep[]): LanguageModel;
```

A `LanguageModel` that answers one scripted step per model call.

Hand it to `createTextAgent({ model })` — or to anything else that takes a
resolved model, which is what the studio's own coding-agent specs do — and the
turn takes the production path with nothing faked below the provider socket:
the real tool executor, the real `ctx`, the real step budget.

Past the end of the script it answers with an EMPTY step rather than throwing,
for the reason `createScriptedOneShotModel` gives: a turn that took one step
more than a spec expected should fail on the assertion that names the
difference, not on a fake running dry.

#### Parameters

##### steps

readonly [`ScriptedTextStep`](#scriptedtextstep)[]

One entry per model call, in order.

#### Returns

`LanguageModel`

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { createTextAgent } from "@alexkroman1/aai-runtime";
import { scriptedTextModel } from "@alexkroman1/aai-runtime/testing";

const chat = createTextAgent({
  agent: agent({ name: "Desk", text: true, systemPrompt: "Be brief." }),
  model: scriptedTextModel([
    { text: "Let me check.", toolCalls: [{ name: "look_up", input: { id: "7" } }] },
    { text: "It shipped yesterday." },
  ]),
});

const turn = chat.stream({ messages: [{ role: "user", content: "where is order 7?" }] });
for await (const delta of turn.textStream) console.log(delta);
```

## Classes

### JournalConflictError

A journal call the store REFUSED on the run's own merits.

The one class of journal rejection that is a verdict about the RUN rather than
about the store, and it needs its own type because those two want opposite
handling: a store that is unreachable means the run's state is UNKNOWN, so the
delivery fails and the queue retries it, where a refusal cannot change however
many times it is retried and the right move is to fail the run and say why.
`workflow-replay-journal-failure.ts` is what reads the difference.

Everything else a store may reject with — a reset socket, an exhausted pool, a
full disk, a timeout — is the store, so the set here is CLOSED and small
rather than a classification of driver errors. Today it has exactly one
member, [JournalStore.claimHook](#claimhook)'s token conflict, which is the only
throw this interface documents as "a bug worth failing the run over".

Every backend must raise it for that case or the arms disagree about whether a
conflicted run fails or is retried forever — the platform arm already had the
distinction as an HTTP status (409, versus the retryable statuses that carry
`PLATFORM_UNAVAILABLE_CODE`), and this is that same line drawn once for all
four.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new JournalConflictError(message: string): JournalConflictError;
```

###### Parameters

###### message

`string`

###### Returns

[`JournalConflictError`](#journalconflicterror)

###### Overrides

```ts
Error.constructor
```

#### Methods

##### is()

```ts
static is(value: unknown): value is JournalConflictError;
```

Is this value one? A static rather than `instanceof` at each site, because
a deployed guest holds TWO copies of this package — see
`packages/aai-runtime/CLAUDE.md`, "A deployed guest has TWO copies" — so a
cross-copy `instanceof` is false for an error the other copy constructed.

###### Parameters

###### value

`unknown`

###### Returns

`value is JournalConflictError`

## Interfaces

### TextAgentOptions

Session-fixed configuration for [createTextAgent](https://github.com/alexkroman/agent/tree/main/packages/aai-runtime#readme).

#### Properties

##### agent

```ts
agent: AgentDef;
```

The agent definition. Must declare `text: true`.

##### db?

```ts
optional db?: Db;
```

`ctx.db`. Absent makes `ctx.db` throw with the enablement guidance.

##### env?

```ts
optional env?: AgentEnv;
```

Tenant-owned env: what tool code reads as `ctx.env`, and — unless
`providerEnv` overrides it — where the LLM credential is read from.

##### fetch?

```ts
optional fetch?: {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  (input: string | Request | URL, init?: RequestInit): Promise<Response>;
};
```

Override the builtins' fetch. Tests only — see `BuiltinToolOptions`.

###### Call Signature

```ts
(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
```

[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch)

###### Parameters

###### input

`RequestInfo` \| `URL`

###### init?

`RequestInit`

###### Returns

`Promise`\<`Response`\>

###### Call Signature

```ts
(input: string | Request | URL, init?: RequestInit): Promise<Response>;
```

[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch)

###### Parameters

###### input

`string` \| `Request` \| `URL`

###### init?

`RequestInit`

###### Returns

`Promise`\<`Response`\>

##### logger?

```ts
optional logger?: Logger;
```

Defaults to `consoleLogger`.

##### model?

```ts
optional model?: LanguageModel;
```

Pre-resolved model, bypassing descriptor resolution entirely. For a
caller that already holds a `LanguageModel` (and for tests, which is the
majority use — a text agent's whole observable behaviour is what it
sends the model).

##### onEvent?

```ts
optional onEvent?: (event: 
  | {
  audioFormat: string;
  meta: {
     at: number;
     id: string;
  };
  sampleRate: number;
  sessionId?: string;
  ttsSampleRate: number;
  type: "session.configured";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "audio.completed";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "speech.started";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "speech.stopped";
}
  | {
  eotConfidence?: number;
  meta: {
     at: number;
     id: string;
  };
  text: string;
  type: "user-transcript.updated";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  text: string;
  type: "user-transcript.committed";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  text: string;
  type: "agent-transcript.updated";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  recovery?: "session-failed" | "turn-failed";
  text: string;
  type: "agent-transcript.committed";
}
  | {
  args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  meta: {
     at: number;
     id: string;
  };
  toolCallId: string;
  toolName: string;
  type: "tool.called";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  result: string;
  toolCallId: string;
  type: "tool.completed";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "reply.completed";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "reply.cancelled";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "session.reset";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "session.timed-out";
}
  | {
  code:   | "audio"
     | "connection"
     | "internal"
     | "llm"
     | "protocol"
     | "stt"
     | "tool"
     | "tts";
  fatal: boolean;
  message: string;
  meta: {
     at: number;
     id: string;
  };
  type: "error.reported";
}
  | {
  data: unknown;
  event: string;
  meta: {
     at: number;
     id: string;
  };
  type: "custom.emitted";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  state: unknown;
  type: "state.updated";
}
  | {
  messages: {
     content: string;
     role: "assistant" | "user";
  }[];
  meta: {
     at: number;
     id: string;
  };
  toolCalls: {
     afterMessageIndex: number;
     args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
     callId: string;
     name: string;
     result?: string;
     status: "done" | "pending";
  }[];
  type: "history.restored";
}) => void;
```

Where this conversation's typed events go — the same [SessionEvent](../aai/protocol.md#sessionevent)
stream a voice session emits, narrowed to what a text agent can honestly
report, so every reader in `@alexkroman1/aai-runtime/eval` and every
assertion built on them works over a text turn unchanged.

ADDITIVE, and deliberately so: [TextAgent.stream](https://github.com/alexkroman/agent/tree/main/packages/aai-runtime#readme) still returns the
vendor's `StreamTextResult` and nothing about it changes. A chat surface
consumes that; this is for whoever is GRADING or auditing the agent.
`text-agent-events.ts` carries which events are emitted, which eleven are
not, and why the turn terminator fires exactly once.

**Conversation-scoped, and the envelope carries no turn coordinate** (see
`protocol-events.ts`, which argues that absence), so two overlapping
`stream()` calls on ONE text agent interleave into one stream with nothing
to tell them apart. A caller that needs them separate builds a text agent
per turn — which is what `runTextAgent` does.

###### Parameters

###### event

  \| \{
  `audioFormat`: `string`;
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `sampleRate`: `number`;
  `sessionId?`: `string`;
  `ttsSampleRate`: `number`;
  `type`: `"session.configured"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"audio.completed"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"speech.started"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"speech.stopped"`;
\}
  \| \{
  `eotConfidence?`: `number`;
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `text`: `string`;
  `type`: `"user-transcript.updated"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `text`: `string`;
  `type`: `"user-transcript.committed"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `text`: `string`;
  `type`: `"agent-transcript.updated"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `recovery?`: `"session-failed"` \| `"turn-failed"`;
  `text`: `string`;
  `type`: `"agent-transcript.committed"`;
\}
  \| \{
  `args`: `z.ZodRecord`\<`z.ZodString`, `z.ZodUnknown`\>;
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `toolCallId`: `string`;
  `toolName`: `string`;
  `type`: `"tool.called"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `result`: `string`;
  `toolCallId`: `string`;
  `type`: `"tool.completed"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"reply.completed"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"reply.cancelled"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"session.reset"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"session.timed-out"`;
\}
  \| \{
  `code`:   \| `"audio"`
     \| `"connection"`
     \| `"internal"`
     \| `"llm"`
     \| `"protocol"`
     \| `"stt"`
     \| `"tool"`
     \| `"tts"`;
  `fatal`: `boolean`;
  `message`: `string`;
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"error.reported"`;
\}
  \| \{
  `data`: `unknown`;
  `event`: `string`;
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"custom.emitted"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `state`: `unknown`;
  `type`: `"state.updated"`;
\}
  \| \{
  `messages`: \{
     `content`: `string`;
     `role`: `"assistant"` \| `"user"`;
  \}[];
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `toolCalls`: \{
     `afterMessageIndex`: `number`;
     `args`: `z.ZodRecord`\<`z.ZodString`, `z.ZodUnknown`\>;
     `callId`: `string`;
     `name`: `string`;
     `result?`: `string`;
     `status`: `"done"` \| `"pending"`;
  \}[];
  `type`: `"history.restored"`;
\}

###### Returns

`void`

##### providerEnv?

```ts
optional providerEnv?: ProviderEnv;
```

Env used for provider-credential resolution only. Defaults to `env`.
Split for the same reason `RuntimeOptions` splits them: a host-fallback
env may resolve a model and must never become `ctx.env`.

##### runCode?

```ts
optional runCode?: RunCodeExecutor;
```

In-sandbox `run_code` executor, for an agent that enables that builtin.

##### sessionId?

```ts
optional sessionId?: string;
```

Conversation identity for `ctx.sessionId` and the session's `ctx.state`.
Defaults to a fresh id per text agent — one instance is one conversation,
which is what makes `state` mean the same thing here as in a session.

##### toolTimeoutMs?

```ts
optional toolTimeoutMs?: number;
```

Per-tool-call deadline. Defaults to `TOOL_EXECUTION_TIMEOUT_MS`
(30s), which is a voice-turn budget; a text agent whose tools install
packages or type-check a workspace wants a larger one.

##### workflows?

```ts
optional workflows?: WorkflowClient;
```

`ctx.workflows`. Absent substitutes a client that rejects with the reason.

***

### TextTurnOptions

Per-turn parameters for [TextAgent.stream](https://github.com/alexkroman/agent/tree/main/packages/aai-runtime#readme).

#### Properties

##### maxSteps?

```ts
optional maxSteps?: number;
```

Overrides the agent's `maxSteps` for this turn.

##### messages

```ts
messages: ModelMessage[];
```

The conversation so far, in AI SDK `ModelMessage` form.

##### onStepFinish?

```ts
optional onStepFinish?: (step: StepResult<ToolSet>) => void | Promise<void>;
```

Fires after each completed step, with that step's result.

###### Parameters

###### step

`StepResult`\<`ToolSet`\>

###### Returns

`void` \| `Promise`\<`void`\>

##### prepareStep?

```ts
optional prepareStep?: PrepareStepFunction<ToolSet>;
```

Per-step hook, composed WITH this module's own: whatever it returns is
applied first, and the forced final answer is layered over the result, so
a caller may rewrite the step's messages (compaction, an injected notice)
without being able to hand the model tools on the step the budget
reserved for answering.

##### signal?

```ts
optional signal?: AbortSignal;
```

Aborts the LLM stream and every in-flight tool call.

##### stopWhen?

```ts
optional stopWhen?: readonly (options: {
  steps: readonly StepResult<ToolSet>[];
}) => boolean | PromiseLike<boolean>[];
```

Extra stop conditions, ANDed into the step budget as alternatives — a
wall-clock deadline is the usual one, since a step cap says nothing
about how long a caller waits.

##### systemPrompt?

```ts
optional systemPrompt?: string;
```

Overrides the agent's `systemPrompt` for this turn.

##### temperature?

```ts
optional temperature?: number;
```

Overrides the agent's `temperature` for this turn.

##### toolChoice?

```ts
optional toolChoice?: ToolChoice;
```

Overrides the agent's `toolChoice` for this turn.

## Type Aliases

### DeterminismKind

```ts
type DeterminismKind = "now" | "random" | "uuid";
```

The three reads, which is also the reserved half of the journal's key space.

***

### HookRecord

```ts
type HookRecord = {
  closed?: boolean;
  delivered: boolean;
  payload?: unknown;
  token: string;
};
```

One outstanding HOOK: a body parked on somebody else's answer.

Mutable for the reason [SleepRecord](#sleeprecord) is — it records something that has
not happened yet. It differs in being addressed from OUTSIDE the run: a
signaller knows the token, not the run id, which is why the store carries a
token index and why `token` is unique across runs rather than per run.

#### Properties

##### closed?

```ts
optional closed?: boolean;
```

True once the wait's WINDOW closed unanswered, so no signal may be taken.

Not cosmetic, and not the same as `delivered`. A body whose
`waitFor(token, { timeoutMs })` timed out has already returned `undefined`
and moved on; if a signal could still land, the next replay would read a
payload, take the ANSWERED branch, and the two walks of the body would
disagree about what happened. Closing it is what keeps the answer a fact.

##### delivered

```ts
delivered: boolean;
```

True once somebody signalled. `payload` is only meaningful then.

##### payload?

```ts
optional payload?: unknown;
```

##### token

```ts
token: string;
```

***

### JournalStore

```ts
type JournalStore = {
  resumableRuns?: (limit: number) => Promise<ResumableRun[]>;
  appendStep: Promise<StepEntry>;
  claimAttempt: Promise<number>;
  claimHook: Promise<HookRecord>;
  claimSleep: Promise<SleepRecord>;
  closeHook: Promise<boolean>;
  createRun: Promise<void>;
  deliverHook: Promise<string | undefined>;
  getRun: Promise<RunRecord | undefined>;
  listRuns: Promise<RunRecord[]>;
  readSleeps: Promise<SleepEntry[]>;
  readStep: Promise<StepEntry | undefined>;
  readSteps: Promise<StepEntry[]>;
  releaseAttempt: Promise<void>;
  setStatus: Promise<boolean>;
  wakeSleeps: Promise<number>;
};
```

The durable store, as the engine needs it.

Deliberately has no `updateStep` and no `deleteRun`: the journal is
APPEND-ONLY and a run's history is what `aai workflow` reads, so a mutation
primitive would be a way to make a replay disagree with what an operator was
shown. Sweeping old runs is the platform's own job and happens below this
interface.

## Four of these need a run, and what happens without one is UNDER-SPECIFIED

[JournalStore.claimAttempt](#claimattempt), [JournalStore.claimSleep](#claimsleep),
[JournalStore.claimHook](#claimhook) and [JournalStore.appendStep](#appendstep) are defined
only for a run that EXISTS. A backend MAY throw — memory does; both databases
insert a row with no run to belong to and answer normally. Deliberately left
under-specified: the engine calls these only after `createRun`, mandating the
throw costs the databases a read or a foreign key per step to detect a state
it cannot reach, and mandating the answer would have memory invent a slot,
i.e. resurrect a run.

#### Methods

##### appendStep()

```ts
appendStep(runId: string, entry: StepEntry): Promise<StepEntry>;
```

Append one settled step.

Idempotent on `key`: a redelivery that re-runs a step whose entry landed
just before the crash must not produce a second entry. Resolves the entry
that is now authoritative — the one already stored, when there was one — so
the engine returns the FIRST result rather than its own, which is what keeps
a replay deterministic across a double execution.

###### Parameters

###### runId

`string`

###### entry

[`StepEntry`](#stepentry)

###### Returns

`Promise`\<[`StepEntry`](#stepentry)\>

##### claimAttempt()

```ts
claimAttempt(
   runId: string, 
   key: string, 
   holder: string, 
   leaseMs: number
): Promise<number>;
```

Charge one attempt for `key` and resolve how many are outstanding.

Called BEFORE the step body runs, and that order is the whole contract: a
process that dies mid-step has already burned the attempt, so a step whose
body wedges the guest cannot be redelivered forever. It is the property the
DevKit's queue had, and reproducing it is why this is a separate primitive
rather than a field the settling entry carries — an entry is written when a
step FINISHES, which is exactly the event a crash denies us.

**A charge is a LEASE, not a tally** — see [JournalStore.releaseAttempt](#releaseattempt),
which gives one back. So the number this answers is not "how many times has
this step been tried", it is **how many attempts are outstanding right now,
this one included**: attempts still running, plus every attempt that ended
in no outcome at all because the worker holding it died. That is the
quantity a pre-body ceiling was always trying to bound. It used to be a bare
tally, and the difference is a durable-execution defect rather than a nuance
— a suspend, a duplicate delivery and an in-process retry each spent from
one budget that only a crash was supposed to spend, so two overlapping
deliveries of a step whose body sleeps burned four attempts of three and the
loser journaled `failed` over a step that had SUCCEEDED. See
`workflow-replay-step.ts`, "An attempt is a lease".

## `holder` is WHOSE lease, and it is what makes the charge attributable

The walk's own id (`replayRun` mints one per walk). Two things follow, and
the second is why the parameter exists at all:

- **A claim is IDEMPOTENT for a holder that already has one.** Re-claiming
  answers the same number rather than a higher one. Today the engine claims
  once per walk per key, so this is a defence rather than a fix — but this
  is a non-idempotent write over an at-least-once transport, and the
  platform backend's own doc has to say "must not soften it by retrying the
  call itself" precisely because a retry used to cost an attempt.
- **A charge can EXPIRE.** A scalar counter cannot: the charge a dead walk
  left is indistinguishable from a live one, so it stood forever and
  `maxAttempts` deaths on one key refused that step permanently. Expiring
  individual charges needs a timestamp per charge, which needs a row per
  charge, which needs the holder in the key.

## `leaseMs` is how long a charge counts for

A charge older than this does not appear in the answer, and is the store's
to forget. The window is the CALLER's policy — `ATTEMPT_LEASE_MS` in
`workflow-replay-attempt.ts` carries the number and the argument for it,
including why it is generous and what a heartbeat would buy.

The store must NOT refresh a live holder's `claimed_at` on a re-claim: the
lease measures how long ago the attempt STARTED, and refreshing it would let
a walk that keeps re-reaching one key hold a charge indefinitely — the
failure the expiry exists to end, by a slower route.

Monotonic per `(runId, key)` in the only sense that matters for correctness:
two concurrent charges by DIFFERENT holders never answer the same number. A
backend implements it as one statement that writes and then counts; anything
that reads then writes can hand the same number to two concurrent
deliveries and let a step exceed its ceiling.

###### Parameters

###### runId

`string`

###### key

`string`

###### holder

`string`

###### leaseMs

`number`

###### Returns

`Promise`\<`number`\>

##### claimHook()

```ts
claimHook(
   runId: string, 
   key: string, 
   token: string
): Promise<HookRecord>;
```

Register a hook the body is parked on, or read back what was delivered.

Idempotent on `key`, for the same replay reason `claimSleep` is: the body is
re-walked on every delivery and must find the SAME hook rather than
registering a second one.

A `token` already registered by a DIFFERENT run or key is a conflict and
throws: two waits sharing a token means one signal resolves whichever the
store happens to find and the other waits forever, which is a bug worth
failing the run over rather than resolving arbitrarily.

**It throws a [JournalConflictError](#journalconflicterror)**, which is what tells the engine
to fail the run rather than treat the store as unavailable and retry the
delivery forever. Every backend owes that type for this case.

###### Parameters

###### runId

`string`

###### key

`string`

###### token

`string`

###### Returns

`Promise`\<[`HookRecord`](#hookrecord)\>

##### claimSleep()

```ts
claimSleep(
   runId: string, 
   key: string, 
   wakeAt: number, 
   correlationId: string | undefined, 
   kind?: "sleep" | "hookTimeout"
): Promise<SleepRecord>;
```

Record this sleep's wake time the FIRST time it is reached, and read back
whatever is stored on every reach after.

Idempotent on `key`, and that is the property the whole mechanism rests on:
a body is replayed, so `ctx.sleep("poll", 60_000)` is evaluated again on every
delivery. Storing the newly-computed deadline each time would push it 60
seconds further out per replay and the run would never wake. So the first
write wins and later calls are reads.

Resolves the record now in force — the stored one when there was one.

###### Parameters

###### runId

`string`

###### key

`string`

###### wakeAt

`number`

###### correlationId

`string` \| `undefined`

###### kind?

`"sleep"` \| `"hookTimeout"`

###### Returns

`Promise`\<[`SleepRecord`](#sleeprecord)\>

##### closeHook()

```ts
closeHook(runId: string, key: string): Promise<boolean>;
```

Refuse any further signal for this wait, the window having closed.

Called by the engine on the timeout path, BEFORE the body continues — see
[HookRecord.closed](#closed) for the divergence it prevents.

A COMPARE-AND-SET on `delivered`, and the boolean is what decides the
branch. Unconditional, it prevented only half the divergence it is
documented to prevent: the engine reads the deadline, then closes, and a
signal landing between the two left this walk taking the TIMED-OUT branch
while every later replay read `delivered: true` and took the ANSWERED one.

Resolves `true` when no signal may be taken through this window — it is
closed now, was already closed, or is gone entirely (a terminal run releases
its tokens) — so the caller may return the timeout. Resolves `false` ONLY
when the window was already ANSWERED, in which case the caller owes the
answered branch instead.

###### Parameters

###### runId

`string`

###### key

`string`

###### Returns

`Promise`\<`boolean`\>

##### createRun()

```ts
createRun(record: RunRecord): Promise<void>;
```

Create the run record. Rejects if `runId` already exists — the id is minted
by the caller, so a collision means two starts raced and exactly one may win.

###### Parameters

###### record

[`RunRecord`](#runrecord)

###### Returns

`Promise`\<`void`\>

##### deliverHook()

```ts
deliverHook(token: string, payload: unknown): Promise<string | undefined>;
```

Deliver `payload` to whatever holds `token`.

Resolves the run id that was waiting, or `undefined` when nothing holds the
token — the ORDINARY answer, since a token whose run has moved on, finished,
closed its window or never started is indistinguishable to a caller and
needs no error.

Addressed by TOKEN rather than by run id because that is what the signaller
knows: it is answering a question, not driving a particular run.

###### Parameters

###### token

`string`

###### payload

`unknown`

###### Returns

`Promise`\<`string` \| `undefined`\>

##### getRun()

```ts
getRun(runId: string): Promise<RunRecord | undefined>;
```

One run, or `undefined` when there is none.

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<[`RunRecord`](#runrecord) \| `undefined`\>

##### listRuns()

```ts
listRuns(workflow: string, limit: number): Promise<RunRecord[]>;
```

Newest first, at most `limit`, filtered to one declared workflow key.

###### Parameters

###### workflow

`string`

###### limit

`number`

###### Returns

`Promise`\<[`RunRecord`](#runrecord)[]\>

##### readSleeps()

```ts
readSleeps(runId: string): Promise<SleepEntry[]>;
```

Every durable wait this run has ever registered, ordered by `key`.

The bulk read [JournalStore.readSteps](#readsteps) is for steps, and it exists for
the same reason — see "A WAIT was outside that guarantee" above. One read
per WALK, taken beside the step read and indexed by the engine; there is no
per-key read beside it because a wait the snapshot cannot answer must be
CLAIMED rather than merely read, which [JournalStore.claimSleep](#claimsleep)
already does.

Both KINDS are in it: a `ctx.sleep` and the deadline half of a
`ctx.waitFor(token, { timeoutMs })` share this table, so a reader that wants
only one filters on [SleepRecord.kind](#kind) rather than expecting the store
to have done it.

Ordered by `key` rather than left unspecified, so the three backends answer
the same array for the same run — the conformance suite compares them
directly, and an order that differs by deployment is the drift that table
exists to catch. It is code-unit order in memory and the column's collation
in both databases, which is the same limit `readSteps` states and is
unobservable for the same reason: the one reader indexes by `key`.

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<[`SleepEntry`](#sleepentry)[]\>

##### readStep()

```ts
readStep(runId: string, key: string): Promise<StepEntry | undefined>;
```

ONE settled step by its key, or `undefined` when it has not settled.

**This does not reopen the question above it** ("Why the journal is read
whole and not queried per step"). That argument is about the WALK's opening
read, where a lookup per `ctx.step` costs a round trip per step per replay
and reading whole costs one whatever the run has done. This answers a
different question, asked on one path only: `settledSince`
(`workflow-replay-attempt.ts`) re-reads a SINGLE key when `claimAttempt`
says somebody else reached it, to find out whether they settled it. That
call site had no keyed primitive, so it read the whole journal and kept one
entry — an O(N) scan to answer an O(1) question, on the contended path, in
exactly the runs where N is largest.

Both databases key this table `(run_id, key)` (the platform's adds `slug`),
so this is an index seek rather than a scan and needs no new index.

###### Parameters

###### runId

`string`

###### key

`string`

###### Returns

`Promise`\<[`StepEntry`](#stepentry) \| `undefined`\>

##### readSteps()

```ts
readSteps(runId: string): Promise<StepEntry[]>;
```

Every settled step for a run, ordered by `finishedAt`, ties broken by `key`.

The tie is what the wording pins down, and it used to say "in the order they
settled" — which memory implemented as insertion order while both databases
ran `order by finished_at, key`, so two steps of one fan-out settling inside
one millisecond came back in opposite orders depending on where the run was
deployed. The databases are right and memory sorts now.

One limit stated rather than pretended away: a database breaks the tie in
the column's COLLATION, which for `text` under a non-C collation is not
code-unit order — and step keys are punctuation-heavy (`fetch#0`,
`sleep!0`). So a BYTE-EXACT tie order is not promised without
`collate "C"` on the column. It is unobservable in practice: a tie needs two
steps settling within one millisecond, and the engine indexes what this
returns by `key`.

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<[`StepEntry`](#stepentry)[]\>

##### releaseAttempt()

```ts
releaseAttempt(
   runId: string, 
   key: string, 
   holder: string
): Promise<void>;
```

Give back one attempt charged for `key`. Floored at zero.

Called when the attempt ended in a durable WAIT — the body suspended, so the
run is mid-flight and the next delivery will reach this step again. That is
the one outcome which leaves no journal entry AND is not the condition
[JournalStore.claimAttempt](#claimattempt)'s ceiling exists to catch. Everything else
either settles the step, in which case the entry is authoritative and the
charge is never read again, or leaves the charge deliberately standing:

- **A death keeps it, and that asymmetry is the whole mechanism.** A worker
  that dies mid-body cannot release, so the charge is the only evidence the
  attempt happened — which is also what the divergence check reads (see
  `workflow-replay-divergence.ts`, "two facts decide it").
- **An in-process retry keeps it**, being the same walk working on the same
  step. A charge per TRY would leave a window between the release and the
  next claim in which a kill leaves no evidence at all.
- **An ABORT keeps it**, for the same reason a death does: the walk is over
  and it did not finish.

Idempotent, and now MATCHED to a holder rather than floored at zero: the
charge being given back is a row, so a release that lands twice deletes
nothing the second time and a release can no longer take somebody else's
charge. The old floor existed because a decrement could not tell whose
charge it was spending, and it kept the safe direction — under-charge a
budget the next claim re-takes, rather than let a wedging step reach an
unbounded one. Naming the row keeps that direction and stops needing the
floor.

The happy path therefore still costs exactly one journal round trip per
step: no release at all.

###### Parameters

###### runId

`string`

###### key

`string`

###### holder

`string`

###### Returns

`Promise`\<`void`\>

##### setStatus()

```ts
setStatus(
   runId: string, 
   next: WorkflowRunStatus, 
   patch?: {
  error?: {
     message: string;
  };
  output?: unknown;
}, 
   expect?: readonly WorkflowRunStatus[]
): Promise<boolean>;
```

Move a run's status, and with it the terminal payload.

`expect` is a COMPARE-AND-SET on the current status, and it is what stops
two deliveries of the same message both completing a run. A backend that
cannot do this atomically must say so rather than approximating it: the
failure it prevents is a cancelled run being marked `completed` by a worker
that had not noticed.

Resolves `false` when the run was not in `expect`.

**The patch is ADDITIVE.** A field it does not carry is not written, and an
explicit `undefined` is the same as absent — so a stored `output` can never
be CLEARED. That is what `error` has always done in all three backends, so
the alternative leaves two fields of one patch with two rules; the platform
cannot express the distinction at all without a new wire field
(`JSON.stringify` drops an `undefined` key, so "no patch" and "clear it" are
already the same bytes); and unwriting a terminal payload is the mutation
primitive this interface says outright it does not have.

###### Parameters

###### runId

`string`

###### next

[`WorkflowRunStatus`](../aai/workflow-api.md#workflowrunstatus)

###### patch?

###### error?

\{
  `message`: `string`;
\}

###### error.message

`string`

###### output?

`unknown`

###### expect?

readonly [`WorkflowRunStatus`](../aai/workflow-api.md#workflowrunstatus)[]

###### Returns

`Promise`\<`boolean`\>

##### wakeSleeps()

```ts
wakeSleeps(runId: string, correlationIds: readonly string[] | undefined): Promise<number>;
```

Cut short the run's outstanding waits, and resolve how many were stopped.

`correlationIds` narrows to the waits declared with one of those ids;
omitted, every outstanding `sleep` is woken and a hook's DEADLINE is not —
see [SleepRecord.kind](#kind) for the approval window that used to close. A wait already woken,
or already elapsed, is NOT counted — the number is what this call changed,
which is what makes `{ woken: 0 }` an answer a caller can act on rather than
a tie between "nothing was waiting" and "I woke something twice".

###### Parameters

###### runId

`string`

###### correlationIds

readonly `string`[] \| `undefined`

###### Returns

`Promise`\<`number`\>

#### Properties

##### resumableRuns?

```ts
optional resumableRuns?: (limit: number) => Promise<ResumableRun[]>;
```

Every non-terminal run this journal still owes a delivery, newest deadline
LAST, at most `limit`.

**The one query that is not about a single run, and the reason it exists is a
data-loss bug.** A `ctx.sleep` suspends with its deadline in the journal and
its TIMER in the dispatcher's process, and nothing enumerated the journal at
boot — so a run suspended when the process restarted (or when `aai dev`
rebuilt its runtime) sat `running` forever with its whole journal intact, on
every backend, Postgres included. `wake` could not rescue it either: an
elapsed deadline is not a wait [JournalStore.wakeSleeps](#wakesleeps) may stop, so
the run was unreachable through the public API. `createInProcessWorkflowEngine`
sweeps this at construction, which is the in-process half of what
`aai-server/workflow-queue-reconcile.ts` does for a deployed guest.

Two membership rules, both mirroring that reconcile's predicate because it is
the proven version of this question:

- **A PARK is not a stall.** `await ctx.waitFor(token)` with no deadline is
  the steady state of the human-approval workflow the SDK documents, and
  `signal` is what ends it — so a run holding an OPEN window (undelivered,
  unclosed) and no outstanding sleep is EXCLUDED. Including it would cost a
  replay per parked run per boot, which under `aai dev` is per file save.
- **A run with an outstanding sleep is included whatever its kind**, so a
  `waitFor(token, { timeoutMs })` whose deadline was lost still fires. That is
  the qualification that keeps the park rule from hiding a run forever.

**OPTIONAL, and an absent implementation is a DECLARATION.** A backend that
cannot answer omits it, and `createInProcessWorkflowEngine` then WARNS at boot
rather than silently forgetting the runs — a durability tradeoff absent from
the log reads as a bug. `workflow-journal-platform.ts` is the one backend that
omits it on purpose: a deployed guest's schedule lives in the platform's
queue, whose reconcile already recovers a lost one server-side, so a sweep
here would be a second recovery mechanism booting a sandbox per copy. See
that module's own note.

###### Parameters

###### limit

`number`

###### Returns

`Promise`\<[`ResumableRun`](#resumablerun)[]\>

***

### ResumableRun

```ts
type ResumableRun = {
  runId: string;
  wakeAt?: number;
};
```

One run a local dispatcher still owes a delivery, as [JournalStore.resumableRuns](#resumableruns) answers it.

#### Properties

##### runId

```ts
runId: string;
```

##### wakeAt?

```ts
optional wakeAt?: number;
```

The earliest OUTSTANDING deadline the run is waiting on, or absent when it is
waiting on nothing — a `pending` run whose start was never delivered, or one
killed mid-step. Absent means "deliver now"; a value in the past means the
same and says how overdue it is.

***

### RunRecord

```ts
type RunRecord = {
  codeVersion?: string;
  createdAt: number;
  error?: {
     message: string;
  };
  input: unknown;
  output?: unknown;
  runId: string;
  status: RunStatus;
  workflow: string;
};
```

One run, as stored.

`workflow` is the DECLARED KEY — the name the agent registered it under in
`agent({ workflows })`. Under the DevKit this field held a compiler-minted
`workflowId` and every read had to translate; there is only one identity now,
which is most of what the removal bought.

#### Properties

##### codeVersion?

```ts
optional codeVersion?: string;
```

The bundle this run was STARTED against — `AAI_BUNDLE_SHA256`, or absent
off the platform and for a row that predates the column.

A run outlives the bundle that started it, which is what makes the
divergence message's two-cause fork ("the CODE changed while this run was in
flight" versus "the BODY is non-deterministic") unanswerable from the
journal alone. One version here settles half of it: compared at each walk,
an inequality states the redeploy and an equality eliminates it.

It is a DIAGNOSTIC and never a gate — `workflow-code-version.ts` carries
why a mismatch does not refuse the run, and why the value has to come from
the process environment rather than the agent's.

##### createdAt

```ts
createdAt: number;
```

##### error?

```ts
optional error?: {
  message: string;
};
```

Set once `status` is `failed`.

###### message

```ts
message: string;
```

##### input

```ts
input: unknown;
```

The validated input the run was started with.

##### output?

```ts
optional output?: unknown;
```

Set once `status` is `completed`.

##### runId

```ts
runId: string;
```

##### status

```ts
status: RunStatus;
```

##### workflow

```ts
workflow: string;
```

***

### RunStatus

```ts
type RunStatus = WorkflowRunStatus;
```

Where a run is — the PUBLIC union, imported rather than restated.

An earlier draft wrote the five members out here under a comment claiming they
were "pinned equal to the public `WorkflowRunStatus` by its own spec". No such
spec existed: `workflow-status-align.test.ts` pins the public union against the
DevKit's, which is a different claim, so this was a third hand-copy that
nothing checked. It is an alias now, which makes the question unaskable.

***

### RunTextAgentOptions

```ts
type RunTextAgentOptions = Omit<TextAgentOptions, "agent" | "model"> & Pick<TextTurnOptions, "signal" | "systemPrompt" | "maxSteps" | "temperature" | "toolChoice"> & {
  script: readonly ScriptedTextStep[];
};
```

What [runTextAgent](#runtextagent) takes, beyond the definition and the conversation.

The agent half is `TextAgentOptions` MINUS the two things this helper
supplies — derived by subtraction rather than restated, for the reason
`agent-server-forwarding.ts` exists in this package: every field of that type
is optional, so an omission is valid TypeScript and presents as a harness
quietly ignoring part of its own configuration. A capability added to a text
agent is reachable from here the day it lands.

The turn half is deliberately NOT the whole of `TextTurnOptions`. `stopWhen`,
`prepareStep` and `onStepFinish` are hooks a chat surface installs, and a
caller that wants one is past the point where a one-call convenience helps —
it builds the agent with `createTextAgent` and streams the turn itself.

#### Type Declaration

##### script

```ts
readonly script: readonly ScriptedTextStep[];
```

One entry per model call — see [ScriptedTextStep](#scriptedtextstep).

Required, because a run with no script is a run against a model that
answers nothing, which is a spec asserting on silence by accident.

***

### RunWorkflowOptions

```ts
type RunWorkflowOptions = {
  crashAt?: string;
  journal?: JournalStore;
  logger?: Logger;
  maxDeliveries?: number;
  name?: string;
};
```

What [runWorkflow](#runworkflow) takes.

#### Properties

##### crashAt?

```ts
optional crashAt?: string;
```

Kill the first delivery that reaches this step, before its body runs.

A worker that died mid-run, which is the one durable-execution failure a
body cannot be written against without being able to produce it. It fires
ONCE and then disarms, so `restart` resumes rather
than crashing again.

The kill lands after the step's attempt has been CHARGED and before its body
runs, which is exactly where a real death lands — the charge is what a
resume reads to tell an abandoned attempt from one that never started.

##### journal?

```ts
optional journal?: JournalStore;
```

The store the run lives in. Defaults to a fresh in-memory journal.

Pass one to start two runs in the same world, or to inspect the journal a
previous run left behind.

##### logger?

```ts
optional logger?: Logger;
```

Where the engine logs. Defaults to silence.

##### maxDeliveries?

```ts
optional maxDeliveries?: number;
```

How many deliveries the driver may make before it gives up.

A bound rather than a timeout: a body that suspends and is woken in a loop
would otherwise spin, and a spec that hangs reports the runner's timeout
instead of the loop. Defaults to [DEFAULT\_MAX\_DELIVERIES](#default_max_deliveries).

##### name?

```ts
optional name?: string;
```

The name the workflow is registered under, as `agent({ workflows })` keys
it. Defaults to `"workflow"`.

It is what the body reads as `ctx.workflow`, and what a run's record
carries — so a spec asserting on either passes the real key.

***

### ScriptedTextStep

```ts
type ScriptedTextStep = {
  text?: string;
  toolCalls?: readonly ScriptedToolCall[];
};
```

One step of a scripted turn: what the model says, and what it calls.

A step with tool calls finishes as `tool-calls`, so the agent runs them and
comes back for the next step; a step without them ends the turn. That makes a
tool-calling turn the obvious two-entry script — the call, then the answer —
and a plain reply a one-entry one.

#### Properties

##### text?

```ts
readonly optional text?: string;
```

What the model streams as text on this step. Absent streams none.

##### toolCalls?

```ts
readonly optional toolCalls?: readonly ScriptedToolCall[];
```

The tool calls the model makes on this step, in order.

***

### ScriptedToolCall

```ts
type ScriptedToolCall = {
  id?: string;
  input?: Record<string, unknown>;
  name: string;
};
```

One tool call in a [ScriptedTextStep](#scriptedtextstep).

#### Properties

##### id?

```ts
readonly optional id?: string;
```

The call id. Defaults to `call-1`, `call-2`, … across the whole script.

Worth naming only when a spec asserts on the id itself — everything a turn
reports carries it, so two calls of one tool are already distinguishable
without one.

##### input?

```ts
readonly optional input?: Record<string, unknown>;
```

The arguments, as an object.

Serialized to the JSON string the wire carries, so a spec writes the
arguments it means and the real coercion, Standard Schema validation and
repair path (`tool-call-repair.ts`) all still run on the way in — which is
the point of scripting a MODEL rather than calling `execute` directly.
Defaults to `{}`.

##### name

```ts
readonly name: string;
```

The tool's name, as the agent's `tools` record keys it.

***

### SleepEntry

```ts
type SleepEntry = SleepRecord & {
  key: string;
};
```

One durable wait AND the key it is stored under — what a BULK read answers.

`SleepRecord` is what [JournalStore.claimSleep](#claimsleep) hands back, and that
caller already knows the key it asked about. [JournalStore.readSleeps](#readsleeps)
answers about a whole run, so the key has to travel with the record; this is
exactly the relationship [StepEntry](#stepentry) has to a step's payload, which is
why it carries its own `key` too rather than being returned in a map.

An array rather than a `Map` because it crosses the platform's wire as JSON,
where a map is not representable — the same reason `readSteps` answers one.

#### Type Declaration

##### key

```ts
key: string;
```

***

### SleepRecord

```ts
type SleepRecord = {
  correlationId?: string;
  kind: "sleep" | "hookTimeout";
  wakeAt: number;
  woken: boolean;
};
```

One durable WAIT, as stored.

Unlike a [StepEntry](#stepentry) this is MUTABLE, and the difference is real rather
than an inconsistency: a step entry records something that happened, where a
sleep records something that has not happened yet. `wake` is what changes it,
which is the whole point of `ctx.workflows.wake(runId)` — a scheduled wait a
caller decides to cut short. An append-only log cannot express that without a
tombstone convention every backend would have to agree on.

#### Properties

##### correlationId?

```ts
optional correlationId?: string;
```

What a targeted `wake` matches on, when the author named one.

##### kind

```ts
kind: "sleep" | "hookTimeout";
```

What this wait IS, which decides whether a broad wake may end it.

A `waitFor(token, { timeoutMs })` journals its deadline through the same
primitive as a `ctx.sleep`, and without this they were indistinguishable — so
`ctx.workflows.wakeUp(runId)` with no ids, which is the "send it now" call a
tool makes to cut a SCHEDULE short, also closed any pending approval window
on that run. A body cancelling a human approval it never asked to cancel.

A bare wake therefore reaches `sleep` only. A hook's deadline is ended by
naming its correlation id, or by the answer arriving.

##### wakeAt

```ts
wakeAt: number;
```

When the body may continue. Decided ONCE, on the first reach.

##### woken

```ts
woken: boolean;
```

Set by [JournalStore.wakeSleeps](#wakesleeps). A woken sleep returns immediately.

***

### StepEntry

```ts
type StepEntry = {
  attempts: number;
  error?: {
     message: string;
  };
  finishedAt: number;
  key: string;
  name: string;
  output?: unknown;
  startedAt?: number;
  status: "ok" | "failed";
};
```

One journal entry: a step that reached a verdict.

Only SETTLED steps are journaled. A step that is mid-flight has no entry, so a
crash leaves the journal describing exactly the work that finished — which is
what makes replay safe to run against it without a reconciliation pass.

`key` is `name#occurrence` — see `WorkflowContext` in the SDK for why identity is
that pair and not an ordinal or a bare name.

#### Properties

##### attempts

```ts
attempts: number;
```

Attempts this step consumed, counting the one that settled it.

##### error?

```ts
optional error?: {
  message: string;
};
```

###### message

```ts
message: string;
```

##### finishedAt

```ts
finishedAt: number;
```

##### key

```ts
key: string;
```

##### name

```ts
name: string;
```

The step's own name, without the occurrence suffix — for `aai workflow` output.

##### output?

```ts
optional output?: unknown;
```

##### startedAt?

```ts
optional startedAt?: number;
```

When the walk REACHED this step, so `finishedAt - startedAt` is what it
cost.

"Which step is slow" was unanswerable from the journal: an entry carried
`attempts` and `finishedAt` and no start, so the only thing derivable was
the gap between one step's finish and the next's — which is the previous
step's cost PLUS whatever the body did between them, and is nothing at all
for the first step of a run or the first after a wait. The 660 MiB
production case in `packages/aai-runtime/CLAUDE.md` is described in terms
nobody could query.

An absolute instant rather than a `durationMs`, because the difference is
derivable and the instant is not: a gap between one step's `finishedAt` and
the next's `startedAt` is DELIVERY latency, which is a different question
from step cost and the one that distinguishes a slow step from a slow queue.

It spans the whole REACH — every try and its backoff — because that is what
the run actually spent here. A step that succeeded on its third attempt
after two `Retry-After: 30`s cost a minute of the run's wall clock, and an
entry reporting only the last try would say the run was fast while it was
not; `attempts` beside it is what separates the two readings.

It does NOT include time queued behind `StepGate`, which is taken before
this clock starts. Attributing contention to the step would report a fast
step on a loaded worker as a slow one; it shows in the GAP above instead.

**OPTIONAL, and absence means the row predates this field.** The journal is
append-only over tables that already hold rows, so a run in flight when
this shipped has entries with no start — and a reader must render that as
unknown rather than as zero, which would report a long step as instant.
Every write sets it.

##### status

```ts
status: "ok" | "failed";
```

`ok` carries `output`; `failed` carries `error` and ended the run.

***

### TextAgentTestRun

```ts
type TextAgentTestRun = {
  events: readonly SessionEvent[];
  messages: readonly ModelMessage[];
  steps: readonly StepResult<ToolSet>[];
  text: string;
  texts: readonly string[];
  toolCalls: readonly TextAgentTestToolCall[];
};
```

What one scripted turn produced.

#### Properties

##### events

```ts
readonly events: readonly SessionEvent[];
```

The turn as a typed [SessionEvent](../aai/protocol.md#sessionevent) stream, in order — every event
`TextAgentOptions.onEvent` reported while this turn ran.

**This is the field that makes a text agent GRADEABLE by the same readers a
voice one is.** `@alexkroman1/aai-runtime/eval` answers three questions off
an event list — where a reply ends, what the agent said, which tools it
called with what — and every one of them takes this array unchanged:

```ts
import { agent } from "@alexkroman1/aai";
import { saidIn, toolCallsInEvents, toolNames } from "@alexkroman1/aai-runtime/eval";
import { runTextAgent } from "@alexkroman1/aai-runtime/testing";

const desk = agent({ name: "Desk", text: true });
const run = await runTextAgent(desk, "where is order 7?", {
  script: [
    { text: "Let me check.", toolCalls: [{ name: "look_up", input: { id: "7" } }] },
    { text: "It shipped yesterday." },
  ],
});

console.log(toolNames(toolCallsInEvents(run.events))); // ["look_up"]
console.log(saidIn(run.events)); // ["Let me check.It shipped yesterday."]
```

The three projections above it are not made redundant by it and are not a
second copy of it either: [TextAgentTestRun.toolCalls](#toolcalls-1) carries the
SDK's own parsed `input` where an event carries the wire's record, and
[TextAgentTestRun.steps](#steps) is the escape hatch for a question neither
vocabulary answers. What this adds is the vocabulary the eval tier already
speaks — including the turn TERMINATOR, which is what lets a harness wait
for a reply to end rather than for a timer.

Ends in exactly one `reply.completed` or `reply.cancelled`, on every turn
this helper drives: it consumes the whole stream, so the terminal part has
always passed through by the time this resolves. `text-agent-events.ts`
carries which events a text agent emits and which it refuses.

##### messages

```ts
readonly messages: readonly ModelMessage[];
```

The messages the turn APPENDED — every step's assistant reply and every
tool exchange, as the SDK reconstructs them.

What a caller persists, and what a second turn of the same conversation is
built on: `[...sent, ...run.messages]`. Taken from `responseMessages`
(every step) rather than from `response` (the last step only), for the
reason [TextAgentTestRun.text](#text-1) carries — a tool-calling turn's own
exchange lives in the steps before the last one, so the narrower field
hands back an assistant message with no tool call to explain it.

##### steps

```ts
readonly steps: readonly StepResult<ToolSet>[];
```

The AI SDK's own step results, for an assertion this projection does not
cover — usage, warnings, the per-step finish reason.

The same escape hatch `WorkflowTestHandle.journal` is one surface over, and
for the same reason: a projection that has to grow a field for every
question is a projection nobody can rely on.

##### text

```ts
readonly text: string;
```

Everything the agent said, concatenated across steps — what the caller
heard.

NOT `StreamTextResult.text`, which is the LAST step's text alone. That is
the right value for a chat surface reconstructing one assistant message and
a trap for a spec: a turn that narrates ("let me check") and then calls a
tool reports only the sentence after the call, so an assertion on the
narration silently passes against nothing. Read [TextAgentTestRun.texts](#texts) when the per-step split is what matters.

##### texts

```ts
readonly texts: readonly string[];
```

What the agent said on each step, in order — one entry per model call.

##### toolCalls

```ts
readonly toolCalls: readonly TextAgentTestToolCall[];
```

Every tool call the turn made, in the order the turn made them.

Flattened across steps deliberately: a tool-calling turn's steps are an
artifact of how the loop is cut, while "it looked the order up and then
cancelled it" is the property a spec is about.

***

### TextAgentTestToolCall

```ts
type TextAgentTestToolCall = {
  args: unknown;
  id: string;
  name: string;
  result: unknown;
};
```

One tool call the turn made, with what it was given and what it answered.

The two halves are one record here because they are one EVENT to a spec, and
the SDK hands them back as two arrays that have to be joined on
`toolCallId` — a join every caller was writing, and getting subtly wrong in
the same way: a `toolResults` walk alone silently omits a call that never came
back, which is exactly the case a spec about a failing tool is asserting.

#### Properties

##### args

```ts
readonly args: unknown;
```

What the MODEL asked for — the script's `input`, as the SDK parsed it off
the wire.

Deliberately not the value the tool's `execute` received: coercion and
Standard Schema validation happen inside `executeToolCall`, and nothing the
turn reports carries their output. So a script writing `{ n: "4" }` against
a `z.number()` reads back `{ n: "4" }` here while the tool really got `4` —
a spec asserting on the COERCED value asserts inside the tool, which is the
only place that value exists.

##### id

```ts
readonly id: string;
```

The call id, which is what pairs this call with its result on the wire.

##### name

```ts
readonly name: string;
```

The tool's name, as the model asked for it.

##### result

```ts
readonly result: unknown;
```

What the call answered, as the model sees it.

A STRING in practice, and that is the production path rather than a
projection: `executeToolCall` serializes every result — a thrown error
included, which arrives as a failure string the model can read — because a
tool result is a wire value. So a tool returning `5` reads back `"5"`.

`undefined` for a call the turn never came back from: an aborted turn, or
one the step budget ended on the call.

***

### WorkflowTestHandle

```ts
type WorkflowTestHandle<R> = WorkflowTestRun<R> & {
  journal: JournalStore;
  signalled: boolean;
  advanceSleep: Promise<WorkflowTestHandle<R>>;
  close: Promise<void>;
  expireWaits: Promise<WorkflowTestHandle<R>>;
  restart: Promise<WorkflowTestHandle<R>>;
  signal: Promise<WorkflowTestHandle<R>>;
};
```

A started run, plus the four things a spec can do to it.

Every method drives the run and resolves the SAME handle, so a spec reads the
fields off it afterwards rather than threading a new value:

```ts
import { workflow } from "@alexkroman1/aai";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";

const review = workflow({
  description: "Hold a draft until a human approves it.",
  run: async (_input, ctx) => await ctx.waitFor<{ approved: boolean }>("approval"),
});

const run = await runWorkflow(review, {}, { name: "review" });
await run.signal("approval", { approved: true });
console.log(run.status, run.output);
```

#### Type Declaration

##### journal

```ts
readonly journal: JournalStore;
```

The journal the run lives in, for an assertion this handle does not cover.

The same store a caller may pass in as [RunWorkflowOptions.journal](#journal),
so a spec can start a second run against the same world.

##### signalled

```ts
readonly signalled: boolean;
```

What the last `signal` answered.

##### advanceSleep()

```ts
advanceSleep(correlationIds?: readonly string[]): Promise<WorkflowTestHandle<R>>;
```

Cut short every wait the run is parked on, and deliver.

`ctx.workflows.wakeUp`'s own mechanism, which is what makes it honest: the
journaled deadline is marked woken and the body continues from the journal,
exactly as it would when a tool decides not to wait out a schedule. It does
NOT move a clock, so a body that computes a duration from `ctx.now` still
sees the instant it was journaled with.

A bare call reaches SLEEPS only. A hook's deadline is a different kind of
wait and is ended by naming its correlation id, or by answering it with
`signal` — see `SleepRecord.kind` for the approval
window a bare wake used to close.

Resolves this handle. Read `wakeAt` before calling it to assert what the
body asked for.

###### Parameters

###### correlationIds?

readonly `string`[]

###### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

##### close()

```ts
close(): Promise<void>;
```

Stop the engine.

Nothing leaks without it — this driver injects its own dispatcher, so no
timer is ever armed — but a run left open is still an engine holding a
journal, and calling it is what keeps that true if the driver ever arms one.

###### Returns

`Promise`\<`void`\>

##### expireWaits()

```ts
expireWaits(): Promise<WorkflowTestHandle<R>>;
```

Close every `ctx.waitFor` WINDOW the run is parked on, and deliver.

The branch a body's safe default lives in, and the one nothing else can
reach. A `waitFor(token, { timeoutMs })` journals its deadline as a sleep of
kind `hookTimeout`, and `ctx.workflows.wakeUp` deliberately cannot end one:
a bare wake is the "send it now" call a tool makes to cut a SCHEDULE short,
and letting it also close an approval window would cancel something the body
never asked to cancel. A targeted wake cannot either — the deadline carries
no correlation id. So without this, the only way to reach the timeout branch
is to wait out a window measured in minutes.

It does NOT move a clock and does not rewrite the stored record. It answers
the deadline READ the way an elapsed one answers it — `woken`, which
`SleepRecord` defines as "a woken sleep returns immediately" — for the
duration of the delivery it triggers. Everything downstream is the engine's
own: the close is still a compare-and-set on `delivered`, so a payload that
landed first still wins and the body still takes the ANSWERED branch.

Resolves this handle. A run parked on a `ctx.sleep` is unaffected;
`advanceSleep` is that one.

###### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

##### restart()

```ts
restart(): Promise<WorkflowTestHandle<R>>;
```

Throw this engine away, build a new one over the same journal, and deliver.

The crash model an author cares about: the process is gone and the journal
is not. A step already journaled returns its stored result without running,
and a step that was mid-flight runs again — which is the at-least-once
contract seen from a body's own side.

It models the redelivery a QUEUE makes rather than
`createInProcessWorkflowEngine`'s boot sweep, because this driver owns the
schedule (see [runWorkflow](#runworkflow)). The sweep — the thing that re-enqueues a
run whose deadline outlived the process — has its own property in this
package and is not what a template spec is asserting.

###### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

##### signal()

```ts
signal(token: string, payload?: unknown): Promise<WorkflowTestHandle<R>>;
```

Answer a `ctx.waitFor` token, and deliver.

Resolves this handle. `signalled` says whether
anything was holding the token — `false` for a token nobody waits on, one
already answered, or one whose window has closed, which are the same refusal
a deployed `ctx.workflows.signal` gives.

###### Parameters

###### token

`string`

###### payload?

`unknown`

###### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

#### Type Parameters

##### R

`R`

***

### WorkflowTestRead

```ts
type WorkflowTestRead = {
  key: string;
  kind: DeterminismKind;
  value: unknown;
};
```

One journaled determinism read — what `ctx.now()`, `ctx.random()` or
`ctx.uuid()` answered, and will answer again on every later walk.

#### Properties

##### key

```ts
readonly key: string;
```

`now!0`, `random!0`, `uuid!0` — the reserved key space, per kind.

##### kind

```ts
readonly kind: DeterminismKind;
```

Which affordance this reach was.

##### value

```ts
readonly value: unknown;
```

The value the journal holds, which every replay reads back.

***

### WorkflowTestRun

```ts
type WorkflowTestRun<R> = {
  crashed: boolean;
  deliveries: number;
  error: string | undefined;
  output: R | undefined;
  reads: readonly WorkflowTestRead[];
  runId: string;
  status: WorkflowRunStatus;
  steps: readonly WorkflowTestStep[];
  wakeAt: number | undefined;
};
```

The run, as it stands after the last thing the driver did.

#### Type Parameters

##### R

`R`

What the body returns, taken from the declaration.

#### Properties

##### crashed

```ts
readonly crashed: boolean;
```

True once a [RunWorkflowOptions.crashAt](#crashat) delivery was killed.

##### deliveries

```ts
readonly deliveries: number;
```

Deliveries this run has taken.

A durable run is delivered once per suspension plus once to start, so this
is what a spec reads to assert that a resume really was a SECOND walk rather
than one body that happened to keep going.

##### error

```ts
readonly error: string | undefined;
```

The failure message, once the run is `failed`.

##### output

```ts
readonly output: R | undefined;
```

The body's return value, once the run is `completed`.

##### reads

```ts
readonly reads: readonly WorkflowTestRead[];
```

Every journaled determinism read — `ctx.now()`, `ctx.random()`,
`ctx.uuid()` — in the same canonical order.

Kept apart from [WorkflowTestRun.steps](#steps-1) because the ENGINE keeps them
apart: they are journaled through the same `appendStep` (which is what makes
a second walk read the same value, and what let them ship without a new
`JournalStore` method) but into a reserved key space of their own —
`now!0`, not `now#0` — and `isDeterminismKey` is the engine's own predicate
for the difference. They also carry no attempt, having no body to abandon.

Folding them in was this surface's own bug: a spec asserting which call
sites a body reached got a `now` it never wrote, and the projection was
flattening a distinction the journal makes on purpose.

##### runId

```ts
readonly runId: string;
```

##### status

```ts
readonly status: WorkflowRunStatus;
```

Where the run is.

`running` is the PARKED state as well as the executing one — a durable run
that suspended is in progress, it is just not executing — so a spec that
expects a wait asserts `running` plus a [WorkflowTestRun.wakeAt](#wakeat-2) or a
pending hook.

##### steps

```ts
readonly steps: readonly WorkflowTestStep[];
```

Every settled `ctx.step`, ordered by NAME and then by occurrence.

## Not the journal's order, deliberately

`JournalStore.readSteps` answers by `finishedAt` with the key breaking a
tie, which is the right contract for a STORE — it is what makes three
backends comparable — and the wrong one to hand a spec. Two steps of one
fast walk settle inside the same millisecond routinely, so under that order
the obvious assertion
(`expect(run.steps.map((s) => s.key)).toEqual([…])`) passes on a slow
machine and fails on a quick one. That is a flake whose failure names a
timing detail rather than a bug, which is the shape this repo refuses
everywhere else it observes a clock.

So the order here is a property of the BODY rather than of the run: `name`
ascending, then occurrence NUMERICALLY — `poll#2` before `poll#10`, which a
plain string sort gets wrong. Nothing is lost, because settle order under a
fan-out is the scheduler's and was never assertable anyway.

`ctx.now()`, `ctx.random()` and `ctx.uuid()` are NOT in here — see
[WorkflowTestRun.reads](#reads).

##### wakeAt

```ts
readonly wakeAt: number | undefined;
```

The deadline the run is parked on, when it is parked on one.

Read off what the body's suspension handed the dispatcher, which is the
journaled wake time — so a spec asserting "it slept for a day" compares this
against the instant the run started rather than waiting one.

***

### WorkflowTestStep

```ts
type WorkflowTestStep = {
  attempts: number;
  error?: string;
  key: string;
  name: string;
  output?: unknown;
  status: "ok" | "failed";
};
```

One step the run journaled.

A projection of the engine's own `StepEntry` rather than that type re-exported:
`finishedAt` is a wall clock, so a spec that could see it would be a spec that
could depend on it.

#### Properties

##### attempts

```ts
readonly attempts: number;
```

Attempts this step consumed, counting the one that settled it.

The field a spec asserting a RETRY reads: a `maxAttempts` step whose body
threw once and then succeeded settles at `2`.

##### error?

```ts
readonly optional error?: string;
```

Why it failed. Present when `status` is `failed`.

##### key

```ts
readonly key: string;
```

`name#occurrence` — what makes a step in a loop distinguishable.

##### name

```ts
readonly name: string;
```

The name the body passed `ctx.step`.

##### output?

```ts
readonly optional output?: unknown;
```

What the step returned. Present when `status` is `ok`.

##### status

```ts
readonly status: "ok" | "failed";
```

## Variables

### DEFAULT\_MAX\_DELIVERIES

```ts
const DEFAULT_MAX_DELIVERIES: 50 = 50;
```

How many deliveries one run may take before the driver gives up.

Generous — a template's longest body suspends twice — and low enough that a
body woken in a loop fails in milliseconds with a message naming the bound
rather than hanging until the runner's own timeout, which reports the runner.
