# eval

`@alexkroman1/aai-runtime/eval` — driving an agent from TEXT, to evaluate
what it did.

The gap this closes: unit tests exercise modules, and a fuzz harness asserts
that generated orderings break no invariant. Neither answers **given this
utterance, did the agent do the right thing** — did it call the right tool,
with the right arguments, in the right order, and say the right thing. That
question needs the real runtime, the real LLM loop, the real tool executor and
the real session event stream, with only the two speech stages replaced, which
is exactly what [openEvalSession](#openevalsession) stands up.

```ts no-check
import { openEvalSession } from "@alexkroman1/aai-runtime/eval";
import agentDef from "./agent.ts";

const session = await openEvalSession({ agent: agentDef });
try {
  const turn = await session.say("hi, what can you do?");
  if (!/order/i.test(turn.text)) throw new Error(`said: ${turn.text}`);
} finally {
  await session.close();
}
```

In a vitest project, reach for `describeEval` from
`@alexkroman1/aai-runtime/eval/vitest` instead — it owns the credential gate,
the scripted-model fallback and the per-case session, so a case is its
assertions and nothing else.

**What it does NOT measure**: everything below the audio boundary —
endpointing, splits and merges, barge-in, and the
`speech.started`/`reply.cancelled` ratio. Those are properties of the boundary
the fake stages remove, and no assertion driven through this can say anything
about one. Do not name or report an eval written here in a way that implies
they are covered; `eval/session.ts` and `eval/stub-speech.ts` repeat the
warning at the seams where it would be forgotten.

[openEvalTextAgent](#openevaltextagent) is the same question asked of a TEXT agent, and it
is a second harness rather than an option on the first because
`createRuntime` REFUSES `text: true`: a text agent fills no pipeline stages,
so there is nothing for the fake speech pair to stand between. Everything
above the model is shared — `send()` is `say()`, the turn record is the same
[EvalTurn](#evalturn), and the readers below take a text turn unchanged, because a
text agent emits this same event union narrowed to what it can fill honestly.

`openEvalWorkflows` is the same idea for a `workflowApp()`, which has no
session at all: it starts a real run of the real body over an in-process
engine. **That engine is not durable** — see `eval/workflow-engine.ts`, which
carries the whole account and the four `WorkflowClient` methods that have no
honest answer without a queue. Its `client` is also what
[openEvalSession](#openevalsession)'s `workflows` option takes, which is what makes a
VOICE agent's run-starting tool executable in an eval.

The assertion READERS ([saidIn](#saidin), [toolCallsInEvents](#toolcallsinevents), [TURN\_ENDS](#turn_ends),
[toolArgsIn](#toolargsin), [toolResultIn](#toolresultin), [toolResultsIn](#toolresultsin),
[lastStateIn](#laststatein), [statesIn](#statesin), [customEventsIn](#customeventsin),
[toolNames](#toolnames), [toolCallsInTurns](#toolcallsinturns), [turnCalling](#turncalling),
[completedOutput](#completedoutput)) are here rather than a vocabulary of matchers because
an eval already has a runner: `expect` in a vitest file is the simple case, and
a case that must PROFILE rather than bisect on the first failure wants a
recording runner, which is a different tool. What both need is one honest
answer to "what did the agent say" and "which tools did it call". Each of them
THROWS rather than returning something empty when it has nothing to read —
that is the half a hand-rolled `find`/`?? ""` gets wrong, and it turns a case
asserting against `undefined` into a case that names what actually happened.

The two DIAGNOSTICS ([describeToolCalls](#describetoolcalls), [describeTurn](#describeturn)) are the
same idea for the runner's own half: a reader that throws says what happened,
and an `expect` that fails says "expected undefined to be defined" unless the
case hands it a message. Ten sites across five templates hand-built that
message, four of them byte-identically, which is what says it belongs here.

Exports are enumerated explicitly (no `export *`) so the public surface is
deliberate: a new symbol in one of these modules does not ship as public API
until it is added here.

## Functions

### completedOutput()

```ts
function completedOutput<R>(run: EvalWorkflowRun<R>): R;
```

The output of a run that COMPLETED, or a throw naming what actually happened.

Every workflow eval opened its assertions with the same four lines:

```ts no-check
// The error FIRST, so a failed run names its own reason instead of
// reporting "expected 'failed' to be 'completed'".
expect(run.error).toBeUndefined();
expect(run.status).toBe("completed");
const output = run.output;
if (output === undefined) expect.fail("a completed run must carry an output");
```

Eighteen `expect(run.error).toBeUndefined()` sites across six files, twelve of
them with that comment above them verbatim. **The comment is the finding**: the
ORDER of those two assertions is load-bearing and invisible, and it is the
whole reason the block exists — write the status check first and a failed run
reports `expected 'failed' to be 'completed'`, throwing away the message that
says which step broke and why. A rule whose only enforcement is a copied
comment is a missing function.

It also narrows: [EvalWorkflowRun.output](#output) is `R | undefined` because a
failed run has none, so every case needed the `if (output === undefined)`
guard to reach a field. This returns `R`.

A reader with a throw rather than a matcher, like [toolResultIn](#toolresultin) next
door — an eval brings its own runner, and `expect` in this module would make
`@alexkroman1/aai-runtime/eval` pull one.

```ts no-check
const output = completedOutput(await app.run(digest, { url }));
expect(output.headline).toMatch(/otter/i);
```

#### Type Parameters

##### R

`R`

#### Parameters

##### run

[`EvalWorkflowRun`](#evalworkflowrun)\<`R`\>

#### Returns

`R`

***

### createStubSttOpener()

```ts
function createStubSttOpener(name: string): SttOpener & {
  last: StubSttSession | undefined;
};
```

One fake STT stage, and the last stream it opened.

#### Parameters

##### name

`string`

#### Returns

`SttOpener` & \{
  `last`: [`StubSttSession`](#stubsttsession) \| `undefined`;
\}

***

### createStubTtsOpener()

```ts
function createStubTtsOpener(name: string): TtsOpener & {
  last: StubTtsSession | undefined;
};
```

One fake TTS stage, and the last stream it opened.

#### Parameters

##### name

`string`

#### Returns

`TtsOpener` & \{
  `last`: [`StubTtsSession`](#stubttssession) \| `undefined`;
\}

***

### createVmRunCode()

```ts
function createVmRunCode(options?: VmRunCodeOptions): RunCodeExecutor;
```

Build a `run_code` executor that evaluates in a fresh `node:vm` context and
answers with whatever the code PRINTED.

Pass it as `openEvalSession`'s / `describeEval`'s `runCode`, and the cases can
assert both halves — that the agent reached for code, and what the code came
back with.

A throw from the evaluated code (a `SyntaxError`, a `ReferenceError`, the
timeout) comes back as `{ error }` rather than propagating, so the model is
handed its own failure and the case measures what it did next.

```ts no-check
import { createVmRunCode } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";

describeEval(agentDef, (test) => { … }, { runCode: createVmRunCode() });
```

#### Parameters

##### options?

[`VmRunCodeOptions`](#vmruncodeoptions)

#### Returns

[`RunCodeExecutor`](#runcodeexecutor)

***

### customEventsIn()

```ts
function customEventsIn(events: readonly (
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
})[], name?: string): readonly {
  data: unknown;
  event: string;
}[];
```

An event the AGENT named, via `ctx.send` — `{ event, data }` pairs, in order.

Filtered by name when one is given. A nudge that must arrive ONCE is the shape
that wants this: "exactly one `wind_down` on the third pick, none on the
fourth" is a claim about this list and about nothing else.

#### Parameters

##### events

readonly (
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
\})[]

##### name?

`string`

#### Returns

readonly \{
  `data`: `unknown`;
  `event`: `string`;
\}[]

***

### describeToolCalls()

```ts
function describeToolCalls(calls: readonly EvalToolCall[]): string;
```

`calls` as one line, for the message argument of a failing assertion.

`expect(logged).toBeDefined()` failing prints "expected undefined to be
defined", which says nothing about a desk that talked through three turns
without ever logging the ticket — so every case in the corpus passed a
message, and three of them built this exact string from
`session.toolCalls()`. It is the harness's own job: the readers next door
throw with names precisely because a legible failure is what makes a noisy
instrument usable, and then each case hand-rolled the same sentence anyway.

**A call list that is EMPTY reads as "called no tools", never as an empty
bracket.** That is the case the message exists for — the agent answered with
a question instead of acting — and `tools called: []` is one character away
from looking like the message got truncated.

**And a call that NEVER COMPLETED says so, right beside its name.** That is
the state [EvalToolCall.result](#result) spells as `undefined`, and the state
every message built by hand rendered identically to a call that answered:
`called note_it` while the tool body had not run and `toolCalls[0].result`
was `undefined`, which a case then meets as a chai type error four lines
further on. `openEvalSession` refuses such a turn outright — this is what the
DIAGNOSTIC owes the cases that read a call list some other way (a cancelled
reply, `toolCallsInTurns` over several turns).

```ts
import { describeToolCalls, type EvalSession } from "@alexkroman1/aai-runtime/eval";

export function loggedTicket(session: EvalSession): void {
  const logged = session.toolCalls().find((call) => call.name === "log_ticket");
  // The message an `expect(logged, …)` would carry, and what a bare
  // `toBeDefined()` failure leaves out.
  if (logged === undefined) throw new Error(describeToolCalls(session.toolCalls()));
}
```

#### Parameters

##### calls

readonly [`EvalToolCall`](#evaltoolcall)[]

#### Returns

`string`

***

### describeTurn()

```ts
function describeTurn(turn: EvalTurn): string;
```

One turn as one line — what the agent did, for the message argument of a
failing assertion.

**The highest-count duplication in the eval corpus**: ten sites across five
templates, four of them byte-identical
(`` `tools called: [${turn.toolCalls.map((c) => c.name).join(", ")}]; said: ${turn.text}` ``),
and every one of them the `message` argument to `expect(value, message)`. That
is the harness's own job. The readers in `eval/events.ts` throw with names
precisely because a legible failure is what makes a noisy instrument usable,
and then each case built the sentence by hand anyway.

What it is worth is the failure it turns into a finding.
`expect(started).toBeDefined()` prints "expected undefined to be defined",
which says nothing about a concierge that talked through three turns without
ever staging the change — the failure `travel-concierge`'s own comment records
this message catching.

Three things it says that a hand-rolled copy did not:

- **"called no tools"**, never `[]`. The empty list is the case the message
  exists for — the agent answered with a question instead of acting — and an
  empty bracket reads like the message got truncated.
- **"said nothing"**, never a trailing `said: `. A reply with no committed
  text is a real outcome and the bare form reads as a broken message.
- **"(the reply was cancelled)"**, which is usually the REASON for the other
  two: a cancelled reply is a finding rather than a harness failure
  ([EvalTurn.completed](#completed)), and it is the one fact that explains a turn
  that did nothing and said nothing.

```ts
import { describeTurn, type EvalTurn } from "@alexkroman1/aai-runtime/eval";

export function stagedOn(turn: EvalTurn): void {
  const staged = turn.toolCalls.find((call) => call.name === "update_ticket");
  if (staged === undefined) throw new Error(describeTurn(turn));
}
```

#### Parameters

##### turn

[`EvalTurn`](#evalturn)

#### Returns

`string`

***

### evalCredentials()

```ts
function evalCredentials(agent: AgentDef, hostEnv?: Record<string, string | undefined>): EvalCredentials;
```

Can this machine run evals against `agent`?

An eval spends real tokens on a real key, so a suite that cannot find one has
to SKIP — and a silent skip is the worst outcome available, because a green
run of nothing is indistinguishable from a green run of something. This is
the gate: it reports what is missing so the skip can say how to fix itself.

**It asks "can this machine run this AGENT", not "which keys does a
text-driven eval dial".** Those differ: the speech stages are faked, so an
agent declaring `stt: deepgram()` never opens Deepgram here. Answering the
narrower question would let an eval pass on a machine where the agent's own
`aai dev` cannot start, and the second answer also changes whenever the fakes
change — a gate whose meaning moves under it is not a gate.

#### Parameters

##### agent

[`AgentDef`](../aai/index.md#agentdef)

##### hostEnv?

`Record`\<`string`, `string` \| `undefined`\>

#### Returns

[`EvalCredentials`](#evalcredentials)

***

### evalWorkflowCredentials()

```ts
function evalWorkflowCredentials(agent: AgentDef, hostEnv?: Record<string, string | undefined>): EvalCredentials;
```

Can this machine run workflow evals against `agent`?

The sibling of `evalCredentials`, and it is a DIFFERENT question rather than a
convenience wrapper: `requiredProviderEnvVars` answers `[]` for a
`page: "static"` agent — correctly, since a workflow app dials no provider
from a session — so asking it alone reports every workflow app ready and every
keyless run live, and every case then fails on a 401 inside a step.

What names a workflow app's credentials is `requiredEnv`, which is exactly why
`link-digest`'s own doc calls that field load-bearing in a way it is not for a
voice agent. So this is the union of the two, checked against the host
environment.

`env` carries provider credentials plus any DECLARED `requiredEnv` name the
host has — declared only, matching `resolveAgentEnv`'s rule, so a step reads
what the agent says it needs and no unrelated shell variable reaches it.

#### Parameters

##### agent

[`AgentDef`](../aai/index.md#agentdef)

##### hostEnv?

`Record`\<`string`, `string` \| `undefined`\>

#### Returns

[`EvalCredentials`](#evalcredentials)

***

### installStubLlm()

```ts
function installStubLlm(script: StubScript): StubLlm;
```

Register a model that answers with `replies`, one per model call, repeating
the last for as long as it is asked.

Repeating rather than falling silent is deliberate: a caller scripting one
reply cannot know how many calls a turn will make (a tool loop makes several),
and an empty answer reads as an agent that stopped talking — a failure that
looks like the agent's and is the harness's.

The kind is UNIQUE per install, because the registry is process-global and two
concurrent eval sessions must not serve each other's replies.

#### Parameters

##### script

[`StubScript`](#stubscript)

#### Returns

[`StubLlm`](#stubllm)

***

### installStubSpeechProviders()

```ts
function installStubSpeechProviders(): StubSpeechProviders;
```

Register both fake stages. Call `release()` when the case is done.

#### Returns

[`StubSpeechProviders`](#stubspeechproviders)

***

### lastStateIn()

#### Call Signature

```ts
function lastStateIn<T>(events: readonly (
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
})[], schema: StandardSchemaV1<unknown, T>): T | undefined;
```

The LATEST state frame the agent pushed (`AgentDef.syncState`) — what the page
is showing.

For a template with a projection this is the strongest assertion available:
not "the tool returned ok" but "the customer can see it". Three separate eval
files hand-rolled this filter plus a cast before it was published.

**Pass the SCHEMA.** The frame is `unknown` on the wire, so the alternative is
a cast, and a cast is silent exactly when the projection changed shape
underneath the eval — which is the regression an eval exists to catch. With a
schema, a frame that stopped matching FAILS naming the field. The overload
without one is for a case that only asks whether anything was pushed.

##### Type Parameters

###### T

`T`

##### Parameters

###### events

readonly (
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
\})[]

###### schema

`StandardSchemaV1`\<`unknown`, `T`\>

##### Returns

`T` \| `undefined`

#### Call Signature

```ts
function lastStateIn(events: readonly (
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
})[]): unknown;
```

The LATEST state frame the agent pushed (`AgentDef.syncState`) — what the page
is showing.

For a template with a projection this is the strongest assertion available:
not "the tool returned ok" but "the customer can see it". Three separate eval
files hand-rolled this filter plus a cast before it was published.

**Pass the SCHEMA.** The frame is `unknown` on the wire, so the alternative is
a cast, and a cast is silent exactly when the projection changed shape
underneath the eval — which is the regression an eval exists to catch. With a
schema, a frame that stopped matching FAILS naming the field. The overload
without one is for a case that only asks whether anything was pushed.

##### Parameters

###### events

readonly (
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
\})[]

##### Returns

`unknown`

***

### openEvalSession()

```ts
function openEvalSession(options: EvalSessionOptions): Promise<EvalSession>;
```

Open an eval session against a real runtime.

The agent definition is used AS GIVEN apart from its two speech stages, which
is the property that matters: an eval measures the agent an author wrote,
including its `events` hooks, its slots and its `tools/` files.

#### Parameters

##### options

[`EvalSessionOptions`](#evalsessionoptions)

#### Returns

`Promise`\<[`EvalSession`](#evalsession)\>

#### Throws

if the agent declares `s2s`. A speech-to-speech agent has no pipeline
  to fake the two ends of — the vendor owns the whole turn — so there is no
  text seam to drive it from, and quietly running it as a pipeline agent would
  evaluate a configuration nobody deployed.

***

### openEvalTextAgent()

```ts
function openEvalTextAgent(options: EvalTextAgentOptions): Promise<EvalTextAgent>;
```

Open an eval conversation against a real text agent.

The definition is used AS GIVEN — including its `events` hooks, its slots and
its `tools/` files — with the model as the only substitution available.

`async` although nothing is awaited, so the surface matches
`openEvalSession`'s: a case reads `await open…(); try { … } finally { await
close(); }` either way, and the two harnesses cannot come to want different
boilerplate.

#### Parameters

##### options

[`EvalTextAgentOptions`](#evaltextagentoptions)

#### Returns

`Promise`\<[`EvalTextAgent`](#evaltextagent)\>

#### Throws

if the agent does not declare `text: true`. That is the mirror of
  `createTextAgent`'s own refusal, made here so the message names the harness
  to use instead.

#### Throws

if the agent declares `s2s`. The vendor owns the whole turn there and
  a text agent has no speech stage at all, so running it as one would evaluate
  a configuration nobody deployed. `AgentParams` refuses the pair at COMPILE
  time with a message of its own; this is the other door — a raw
  `export default {…}`, or a definition loaded from a config, arrives having
  skipped it.

***

### openEvalWorkflows()

```ts
function openEvalWorkflows(options: EvalWorkflowsOptions): EvalWorkflows;
```

Open a workflow app for evaluation.

Synchronous, unlike `openEvalSession`: there is no session to start and no
greeting to wait out. It DOES install process-global step slots, so one app at
a time and `close()` is not optional — see `eval/workflow-engine.ts`.

#### Parameters

##### options

[`EvalWorkflowsOptions`](#evalworkflowsoptions)

#### Returns

[`EvalWorkflows`](#evalworkflows)

#### Throws

if the agent declares no workflows. There is nothing to run, and the
  alternative is a client whose every call fails with the platform's
  "no workflow backend" message, which describes a deployment problem rather
  than this one.

***

### saidIn()

```ts
function saidIn(events: readonly (
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
})[]): readonly string[];
```

The committed agent replies in `events`, in order — what the caller was told.

Committed rather than streamed: a delta is a draft, and a reply the pipeline
cancelled mid-sentence was never heard in full. Asserting on deltas is how an
eval comes to pass on text no caller received.

#### Parameters

##### events

readonly (
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
\})[]

#### Returns

readonly `string`[]

***

### statesIn()

#### Call Signature

```ts
function statesIn<T>(events: readonly (
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
})[], schema: StandardSchemaV1<unknown, T>): readonly T[];
```

Every state frame the agent pushed (`AgentDef.syncState`), oldest first —
what the page showed, in order.

[lastStateIn](#laststatein) answers the newest, which is the right question for "can
the customer see it". The SEQUENCE is a different claim and a stronger one:
"the cart was never shown as placed before the tool ran", "no frame between
these two turns leaked the pending change". Three eval files hand-rolled it —
`events.flatMap((e) => (e.type === "state.updated" ? [Schema.parse(e.state)] : []))`
in three spellings, one of them a `for` loop — and every one of them reached
for the schema, which is the tell that a frame is `unknown` on the wire and
asserting on a cast is how a projection that changed shape stops being
noticed.

A case wanting the frames only up to some point slices `events` first: this
reads whatever list it is given, which is why it takes events rather than a
session.

##### Type Parameters

###### T

`T`

##### Parameters

###### events

readonly (
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
\})[]

###### schema

`StandardSchemaV1`\<`unknown`, `T`\>

##### Returns

readonly `T`[]

#### Call Signature

```ts
function statesIn(events: readonly (
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
})[]): readonly unknown[];
```

Every state frame the agent pushed (`AgentDef.syncState`), oldest first —
what the page showed, in order.

[lastStateIn](#laststatein) answers the newest, which is the right question for "can
the customer see it". The SEQUENCE is a different claim and a stronger one:
"the cart was never shown as placed before the tool ran", "no frame between
these two turns leaked the pending change". Three eval files hand-rolled it —
`events.flatMap((e) => (e.type === "state.updated" ? [Schema.parse(e.state)] : []))`
in three spellings, one of them a `for` loop — and every one of them reached
for the schema, which is the tell that a frame is `unknown` on the wire and
asserting on a cast is how a projection that changed shape stops being
noticed.

A case wanting the frames only up to some point slices `events` first: this
reads whatever list it is given, which is why it takes events rather than a
session.

##### Parameters

###### events

readonly (
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
\})[]

##### Returns

readonly `unknown`[]

***

### toolArgsIn()

#### Call Signature

```ts
function toolArgsIn<T>(
   calls: readonly EvalToolCall[], 
   name: string, 
   schema: StandardSchemaV1<unknown, T>
): readonly T[];
```

Every call to `name` in `calls`, with its ARGUMENTS — what the agent asked
for, in call order.

The plural half of [toolResultIn](#toolresultin), and the one that was missing: nine
eval files wrote `calls.filter((c) => c.name === X).map((c) => c.args.…)` and
three of them wrapped it in a local `codeIn`/`fetchedUrls`/`drugsIn` reader —
twenty-two `.filter((c) => c.name === …)` sites across the corpus.

**Pass the SCHEMA when the case reads a FIELD.** `args` is
`Record<string, unknown>` on the wire — the model produced it and nothing
validated it, since the tool executor is where a bad call is rejected — so the
alternative is `String(c.args.code ?? "")`, which turns an argument the model
renamed, or never sent, into `""`. That is a claim about the agent silently
becoming a claim about nothing: an eval asserting `codeIn(turn)` contains
`Math.PI` passes on an empty string only if the case ALSO asserted the call
happened, and three of them did not. With a schema, arguments that stopped
matching FAIL naming the field.

ZERO calls answers `[]` rather than throwing, unlike [toolResultIn](#toolresultin) —
"it never called this" is a claim the plural form is used to make
(`expect(toolArgsIn(calls, "run_code")).toHaveLength(0)`), where for the
singular it can only be a mistake.

##### Type Parameters

###### T

`T`

##### Parameters

###### calls

readonly [`EvalToolCall`](#evaltoolcall)[]

###### name

`string`

###### schema

`StandardSchemaV1`\<`unknown`, `T`\>

##### Returns

readonly `T`[]

#### Call Signature

```ts
function toolArgsIn(calls: readonly EvalToolCall[], name: string): readonly Record<string, unknown>[];
```

Every call to `name` in `calls`, with its ARGUMENTS — what the agent asked
for, in call order.

The plural half of [toolResultIn](#toolresultin), and the one that was missing: nine
eval files wrote `calls.filter((c) => c.name === X).map((c) => c.args.…)` and
three of them wrapped it in a local `codeIn`/`fetchedUrls`/`drugsIn` reader —
twenty-two `.filter((c) => c.name === …)` sites across the corpus.

**Pass the SCHEMA when the case reads a FIELD.** `args` is
`Record<string, unknown>` on the wire — the model produced it and nothing
validated it, since the tool executor is where a bad call is rejected — so the
alternative is `String(c.args.code ?? "")`, which turns an argument the model
renamed, or never sent, into `""`. That is a claim about the agent silently
becoming a claim about nothing: an eval asserting `codeIn(turn)` contains
`Math.PI` passes on an empty string only if the case ALSO asserted the call
happened, and three of them did not. With a schema, arguments that stopped
matching FAIL naming the field.

ZERO calls answers `[]` rather than throwing, unlike [toolResultIn](#toolresultin) —
"it never called this" is a claim the plural form is used to make
(`expect(toolArgsIn(calls, "run_code")).toHaveLength(0)`), where for the
singular it can only be a mistake.

##### Parameters

###### calls

readonly [`EvalToolCall`](#evaltoolcall)[]

###### name

`string`

##### Returns

readonly `Record`\<`string`, `unknown`\>[]

***

### toolCallsInEvents()

```ts
function toolCallsInEvents(events: readonly (
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
})[]): readonly EvalToolCall[];
```

The tool calls in `events`, each paired with the result event that answered
it. A call with no result is a call that never completed — reported as such
rather than dropped, because "it called the tool and the tool never returned"
is a finding.

#### Parameters

##### events

readonly (
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
\})[]

#### Returns

readonly [`EvalToolCall`](#evaltoolcall)[]

***

### toolCallsInTurns()

```ts
function toolCallsInTurns(turns: readonly EvalTurn[]): readonly EvalToolCall[];
```

Every tool call across `turns`, flattened, in call order — the whole call.

`EvalSession.toolCalls()` answers the same question about the SESSION, and the
difference is the greeting: the session's list carries every call from the
agent's opening line onward, where this carries only the turns a case actually
drove. A claim about "the call" that accidentally includes the greeting is the
same class of mistake as a claim about `said()` that does — see
[EvalTurn](#evalturn).

Hand-rolled in `travel-concierge` as `callsIn`, which is where the shape comes
from. Pair it with `toolNames` for an order claim, or with `toolArgsIn` /
`toolResultsIn` for what each was asked and answered.

#### Parameters

##### turns

readonly [`EvalTurn`](#evalturn)[]

#### Returns

readonly [`EvalToolCall`](#evaltoolcall)[]

***

### toolNames()

```ts
function toolNames(calls: readonly EvalToolCall[]): readonly string[];
```

The names of `calls`, in call order — what the agent reached for.

Thirty `.map((c) => c.name)` sites across the eval corpus, one of which
(`plan-and-execute`) had wrapped it as a local `named()`. Mostly it feeds a
failure message ([describeToolCalls](#describetoolcalls) is that, done properly), but about
six sites are the ASSERTION itself —
`expect(toolNames(turn.toolCalls)).toEqual(["add_pizza"])` — which is the
strongest claim about tool ORDER available, and the reason this is an export
of its own rather than folded into the diagnostic.

Names only: a claim about what a tool was ASKED for goes through
[toolArgsIn](#toolargsin) with a schema, because `args` is `unknown` on the wire and
reading a field off it by hand is how an argument the model renamed becomes
`""`.

#### Parameters

##### calls

readonly [`EvalToolCall`](#evaltoolcall)[]

#### Returns

readonly `string`[]

***

### toolResultIn()

```ts
function toolResultIn<T = unknown>(
   calls: readonly EvalToolCall[], 
   name: string, 
   schema?: StandardSchemaV1<unknown, T>
): T;
```

The result of the ONE call to `name` in `calls`, parsed.

`EvalToolCall.result` is the serialized string the model was handed, so every
eval that asserts on what a tool ANSWERED was parsing and indexing it by
hand — five files had written the same helper. What matters more than the
parse is the THROW: a `find` that misses answers `undefined`, and a case then
asserts against nothing and passes. This names what was called instead.

#### Type Parameters

##### T

`T` = `unknown`

#### Parameters

##### calls

readonly [`EvalToolCall`](#evaltoolcall)[]

##### name

`string`

##### schema?

`StandardSchemaV1`\<`unknown`, `T`\>

#### Returns

`T`

***

### toolResultsIn()

```ts
function toolResultsIn<T = unknown>(
   calls: readonly EvalToolCall[], 
   name: string, 
   schema?: StandardSchemaV1<unknown, T>
): readonly T[];
```

Every call to `name` in `calls`, with its RESULT parsed — what each answered,
in call order.

[toolResultIn](#toolresultin) refuses more than one call on purpose: "the one call to
X" is the common claim and two of them is usually a finding. The plural is the
other half, and three eval files had written it as
`.map((c) => c.result ?? "")` — which turns "the tool never returned" into an
empty string, i.e. drops exactly the finding [toolResultIn](#toolresultin) throws to
report. An incomplete call throws here too, naming its position.

ZERO calls answers `[]`, for the reason [toolArgsIn](#toolargsin) gives.

#### Type Parameters

##### T

`T` = `unknown`

#### Parameters

##### calls

readonly [`EvalToolCall`](#evaltoolcall)[]

##### name

`string`

##### schema?

`StandardSchemaV1`\<`unknown`, `T`\>

#### Returns

readonly `T`[]

***

### turnCalling()

```ts
function turnCalling(
   turns: readonly EvalTurn[], 
   name: string, 
   where?: (call: EvalToolCall) => boolean
): EvalTurn;
```

The turn `name` was called in — the FIRST one, and a throw naming what
happened instead when there is none.

The claim a multi-turn case actually wants to make, and the whole reason
[EvalSession.sayAll](#sayall) exists: "the desk staged the change on the turn it
staged it", never "on turn two". Written out in `retail` as `turnCalling`, in
`travel-concierge` as `stagingTurn` and in `dispatch-center` as an inline
`turns.find(…)`, each under a doc making the same argument.

**It THROWS rather than answering `undefined`, which is a deliberate break
with the shape the templates had.** Every one of them wrote
`const staging = turnCalling(turns, tool)` followed by
`expect(staging, "<hand-built message>").toBeDefined()` and then read fields
off `staging?.…` — three lines and an optional chain to recover from a `find`
that missed. This is the rule the readers next door already follow: the
singular form throws because for it an absent match can only be a mistake, and
the plural answers `[]` because "it never called this" is a claim a case
makes. The plural spelling of THIS claim is
`expect(toolNames(toolCallsInTurns(turns))).not.toContain(name)`, which needs
no turn at all — so nothing is lost, and the return type is `EvalTurn` rather than
`EvalTurn | undefined`, which is what retires the optional chain.

The throw carries what a hand-built message could not afford to: every turn's
tool list, in order, so the failure reads as the shape of the call rather than
as one missing name.

`where` narrows to a call that also satisfies a predicate — the near-variant
`travel-concierge` needed, where the interesting turn is the one whose
`update_ticket` STAGED something rather than being refused by the gate. When
the tool was called and no call matched, the message says so rather than
reporting the tool as never called: those are different findings and only one
of them is about the agent ignoring the tool.

```ts
import { type EvalSession, toolResultIn, turnCalling } from "@alexkroman1/aai-runtime/eval";
import { z } from "zod";

export async function stagesBeforeCommitting(session: EvalSession): Promise<string> {
  const turns = await session.sayAll(["I want to cancel W1234", "Go ahead."]);
  // The turn it staged in, whichever that turned out to be.
  const staging = turnCalling(turns, "cancel_pending_order");
  return toolResultIn(staging.toolCalls, "cancel_pending_order", z.object({ state: z.string() }))
    .state;
}
```

#### Parameters

##### turns

readonly [`EvalTurn`](#evalturn)[]

##### name

`string`

##### where?

(`call`: [`EvalToolCall`](#evaltoolcall)) => `boolean`

#### Returns

[`EvalTurn`](#evalturn)

## Type Aliases

### EvalCredentials

```ts
type EvalCredentials = {
  env: ProviderEnv;
  missing: readonly string[];
  ready: boolean;
  reason: string | undefined;
};
```

What [evalCredentials](#evalcredentials-1) found on this machine.

#### Properties

##### env

```ts
readonly env: ProviderEnv;
```

The provider credentials the host environment carries, ready to hand to
[EvalSessionOptions.providerEnv](#providerenv). Only provider-credential names are
copied, so no unrelated host variable can reach the agent.

##### missing

```ts
readonly missing: readonly string[];
```

Credential names this agent needs and this machine does not have.

##### ready

```ts
readonly ready: boolean;
```

Nothing missing — an eval can run.

##### reason

```ts
readonly reason: string | undefined;
```

Why an eval would skip, phrased as the fix. `undefined` when ready.

***

### EvalEmitted

```ts
type EvalEmitted = {
  chunk: unknown;
  namespace: string;
};
```

One chunk `stepEmit()` wrote during a run, and the stream it named.

#### Properties

##### chunk

```ts
readonly chunk: unknown;
```

The value, exactly as the step passed it.

##### namespace

```ts
readonly namespace: string;
```

The stream the step named.

***

### EvalRunOptions

```ts
type EvalRunOptions = StartOptions & {
  timeoutMs?: number;
};
```

Per-run knobs.

#### Type Declaration

##### timeoutMs?

```ts
readonly optional timeoutMs?: number;
```

Overrides [DEFAULT\_RUN\_TIMEOUT\_MS](#default_run_timeout_ms) for this run.

***

### EvalSession

```ts
type EvalSession = {
  id: string;
  close: Promise<void>;
  events: readonly (
     | {
     audioFormat: z.ZodString;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     sampleRate: z.ZodNumber;
     sessionId?: z.ZodOptional<z.ZodString>;
     ttsSampleRate: z.ZodNumber;
     type: z.ZodLiteral<"session.configured">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"audio.completed">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"speech.started">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"speech.stopped">;
   }
     | {
     eotConfidence?: z.ZodOptional<z.ZodNumber>;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     text: z.ZodString;
     type: z.ZodLiteral<"user-transcript.updated">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     text: z.ZodString;
     type: z.ZodLiteral<"user-transcript.committed">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     text: z.ZodString;
     type: z.ZodLiteral<"agent-transcript.updated">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     recovery?: z.ZodOptional<z.ZodEnum<{
        session-failed: "session-failed";
        turn-failed: "turn-failed";
     }>>;
     text: z.ZodString;
     type: z.ZodLiteral<"agent-transcript.committed">;
   }
     | {
     args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     toolCallId: z.ZodString;
     toolName: z.ZodString;
     type: z.ZodLiteral<"tool.called">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     result: z.ZodString;
     toolCallId: z.ZodString;
     type: z.ZodLiteral<"tool.completed">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"reply.completed">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"reply.cancelled">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"session.reset">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"session.timed-out">;
   }
     | {
     code: z.ZodEnum<{
        audio: "audio";
        connection: "connection";
        internal: "internal";
        llm: "llm";
        protocol: "protocol";
        stt: "stt";
        tool: "tool";
        tts: "tts";
     }>;
     fatal: z.ZodBoolean;
     message: z.ZodString;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"error.reported">;
   }
     | {
     data: z.ZodUnknown;
     event: z.ZodString;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"custom.emitted">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     state: z.ZodUnknown;
     type: z.ZodLiteral<"state.updated">;
   }
     | {
     messages: z.ZodArray<z.ZodObject<{
        content: z.ZodString;
        role: z.ZodEnum<{
           assistant: "assistant";
           user: "user";
        }>;
     }, z.core.$strip>>;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     toolCalls: z.ZodArray<z.ZodObject<{
        afterMessageIndex: z.ZodNumber;
        args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        callId: z.ZodString;
        name: z.ZodString;
        result: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<{
           done: "done";
           pending: "pending";
        }>;
     }, z.core.$strip>>;
     type: z.ZodLiteral<"history.restored">;
  })[];
  said: readonly string[];
  say: Promise<EvalTurn>;
  sayAll: Promise<readonly EvalTurn[]>;
  toolCalls: readonly EvalToolCall[];
};
```

One live eval session.

#### Methods

##### close()

```ts
close(): Promise<void>;
```

###### Returns

`Promise`\<`void`\>

##### events()

```ts
events(): readonly (
  | {
  audioFormat: z.ZodString;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  sampleRate: z.ZodNumber;
  sessionId?: z.ZodOptional<z.ZodString>;
  ttsSampleRate: z.ZodNumber;
  type: z.ZodLiteral<"session.configured">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"audio.completed">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"speech.started">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"speech.stopped">;
}
  | {
  eotConfidence?: z.ZodOptional<z.ZodNumber>;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  text: z.ZodString;
  type: z.ZodLiteral<"user-transcript.updated">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  text: z.ZodString;
  type: z.ZodLiteral<"user-transcript.committed">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  text: z.ZodString;
  type: z.ZodLiteral<"agent-transcript.updated">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  recovery?: z.ZodOptional<z.ZodEnum<{
     session-failed: "session-failed";
     turn-failed: "turn-failed";
  }>>;
  text: z.ZodString;
  type: z.ZodLiteral<"agent-transcript.committed">;
}
  | {
  args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  toolCallId: z.ZodString;
  toolName: z.ZodString;
  type: z.ZodLiteral<"tool.called">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  result: z.ZodString;
  toolCallId: z.ZodString;
  type: z.ZodLiteral<"tool.completed">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"reply.completed">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"reply.cancelled">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"session.reset">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"session.timed-out">;
}
  | {
  code: z.ZodEnum<{
     audio: "audio";
     connection: "connection";
     internal: "internal";
     llm: "llm";
     protocol: "protocol";
     stt: "stt";
     tool: "tool";
     tts: "tts";
  }>;
  fatal: z.ZodBoolean;
  message: z.ZodString;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"error.reported">;
}
  | {
  data: z.ZodUnknown;
  event: z.ZodString;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"custom.emitted">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  state: z.ZodUnknown;
  type: z.ZodLiteral<"state.updated">;
}
  | {
  messages: z.ZodArray<z.ZodObject<{
     content: z.ZodString;
     role: z.ZodEnum<{
        assistant: "assistant";
        user: "user";
     }>;
  }, z.core.$strip>>;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  toolCalls: z.ZodArray<z.ZodObject<{
     afterMessageIndex: z.ZodNumber;
     args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
     callId: z.ZodString;
     name: z.ZodString;
     result: z.ZodOptional<z.ZodString>;
     status: z.ZodEnum<{
        done: "done";
        pending: "pending";
     }>;
  }, z.core.$strip>>;
  type: z.ZodLiteral<"history.restored">;
})[];
```

Every event this session has emitted, in stream order.

###### Returns

readonly (
  \| \{
  `audioFormat`: `z.ZodString`;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `sampleRate`: `z.ZodNumber`;
  `sessionId?`: `z.ZodOptional`\<`z.ZodString`\>;
  `ttsSampleRate`: `z.ZodNumber`;
  `type`: `z.ZodLiteral`\<`"session.configured"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"audio.completed"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"speech.started"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"speech.stopped"`\>;
\}
  \| \{
  `eotConfidence?`: `z.ZodOptional`\<`z.ZodNumber`\>;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `text`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"user-transcript.updated"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `text`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"user-transcript.committed"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `text`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"agent-transcript.updated"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `recovery?`: `z.ZodOptional`\<`z.ZodEnum`\<\{
     `session-failed`: `"session-failed"`;
     `turn-failed`: `"turn-failed"`;
  \}\>\>;
  `text`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"agent-transcript.committed"`\>;
\}
  \| \{
  `args`: `z.ZodRecord`\<`z.ZodString`, `z.ZodUnknown`\>;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `toolCallId`: `z.ZodString`;
  `toolName`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"tool.called"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `result`: `z.ZodString`;
  `toolCallId`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"tool.completed"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"reply.completed"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"reply.cancelled"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"session.reset"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"session.timed-out"`\>;
\}
  \| \{
  `code`: `z.ZodEnum`\<\{
     `audio`: `"audio"`;
     `connection`: `"connection"`;
     `internal`: `"internal"`;
     `llm`: `"llm"`;
     `protocol`: `"protocol"`;
     `stt`: `"stt"`;
     `tool`: `"tool"`;
     `tts`: `"tts"`;
  \}\>;
  `fatal`: `z.ZodBoolean`;
  `message`: `z.ZodString`;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"error.reported"`\>;
\}
  \| \{
  `data`: `z.ZodUnknown`;
  `event`: `z.ZodString`;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"custom.emitted"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `state`: `z.ZodUnknown`;
  `type`: `z.ZodLiteral`\<`"state.updated"`\>;
\}
  \| \{
  `messages`: `z.ZodArray`\<`z.ZodObject`\<\{
     `content`: `z.ZodString`;
     `role`: `z.ZodEnum`\<\{
        `assistant`: `"assistant"`;
        `user`: `"user"`;
     \}\>;
  \}, `z.core.$strip`\>\>;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `toolCalls`: `z.ZodArray`\<`z.ZodObject`\<\{
     `afterMessageIndex`: `z.ZodNumber`;
     `args`: `z.ZodRecord`\<`z.ZodString`, `z.ZodUnknown`\>;
     `callId`: `z.ZodString`;
     `name`: `z.ZodString`;
     `result`: `z.ZodOptional`\<`z.ZodString`\>;
     `status`: `z.ZodEnum`\<\{
        `done`: `"done"`;
        `pending`: `"pending"`;
     \}\>;
  \}, `z.core.$strip`\>\>;
  `type`: `z.ZodLiteral`\<`"history.restored"`\>;
\})[]

##### said()

```ts
said(): readonly string[];
```

Every committed reply so far, INCLUDING the greeting — the agent's opening
line is a real turn and is in the session's history, so it is in this list
too. Prefer the [EvalTurn](#evalturn) `say()` returns for a claim about one
reply.

###### Returns

readonly `string`[]

##### say()

```ts
say(text: string): Promise<EvalTurn>;
```

Commit a user turn, wait for the reply to end, and hand back that turn.

Waits for a reply TERMINATOR rather than for a timer, which is what makes a
case deterministic despite a live model: the next `say()` cannot begin
inside the previous turn, so a recorded tool order is the agent's and not
the harness's.

###### Parameters

###### text

`string`

###### Returns

`Promise`\<[`EvalTurn`](#evalturn)\>

##### sayAll()

```ts
sayAll(lines: readonly string[]): Promise<readonly EvalTurn[]>;
```

Say every line in order, waiting out each reply, and hand back every turn.

Byte-identical in three shipped templates before it was published
(`dispatch-center`, `retail`, `travel-concierge`), each under a doc reaching
the same conclusion independently — which is the tell that it is the
harness's concept rather than any template's. The conclusion is the reason
to reach for this rather than a list of `say()` calls: a case over several
turns must assert about the turn a MECHANISM fired in, never about turn
number two, because how many turns an agent takes to get somewhere is the
model's business and it measurably varies — `retail`'s desk reads the order
back before it stages, so its staging call has landed in turn two, three
and four across live runs. A case pinned to a turn index is a flake with a
misleading name.

`turnCalling`, `toolCallsInTurns` and `describeTurn` (`eval/turns.ts`, published on
the same subpath) are what read the result without pinning an index.

Strictly sequential, like the caller it stands for: each line is committed
only once the reply to the previous one has ended, so a recorded tool order
is the agent's and not the harness's.

###### Parameters

###### lines

readonly `string`[]

###### Returns

`Promise`\<readonly [`EvalTurn`](#evalturn)[]\>

##### toolCalls()

```ts
toolCalls(): readonly EvalToolCall[];
```

The tool calls so far, in call order, each with its result.

###### Returns

readonly [`EvalToolCall`](#evaltoolcall)[]

#### Properties

##### id

```ts
readonly id: string;
```

This session's id — what its tools read as `ctx.sessionId`.

Exposed because it is what a tool CORRELATES a durable run with, so a case
asserting "the run it started is this conversation's" needs both halves.

***

### EvalSessionOptions

```ts
type EvalSessionOptions = {
  agent: AgentDef;
  env?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  generate?: HostGenerateFn;
  llm?: LlmProvider;
  logger?: Logger;
  providerEnv?: ProviderEnv;
  runCode?: RunCodeExecutor;
  toolTimeoutMs?: number;
  turnTimeoutMs?: number;
  workflows?: WorkflowClient;
};
```

What [openEvalSession](#openevalsession) takes.

#### Properties

##### agent

```ts
readonly agent: AgentDef;
```

The agent under eval — an ordinary `agent()` definition.

##### env?

```ts
readonly optional env?: Record<string, string>;
```

The agent's own env, i.e. what its tools read as `ctx.env`. Defaults to
empty: a tool that needs a value gets it here, and nothing is inherited
implicitly.

##### fetch?

```ts
readonly optional fetch?: typeof globalThis.fetch;
```

The `fetch` the builtin web tools use. Pass one to keep a case off the
network — a scripted `visit_webpage` really visits.

##### generate?

```ts
readonly optional generate?: HostGenerateFn;
```

What tool code calls as `ctx.generate`. Absent, it is the agent's own LLM.

`describeEval`'s `stubGenerate` builds one of these; the reason it must be
separate from the turn's script is in `RuntimeOptions.generate`.

##### llm?

```ts
readonly optional llm?: LlmProvider;
```

Override the LLM the case runs on. Defaults to the agent's own.

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to silent. Pass `consoleLogger` when diagnosing a case.

##### providerEnv?

```ts
readonly optional providerEnv?: ProviderEnv;
```

Where provider credentials are resolved from. Defaults to
[EvalSessionOptions.env](#env-1) with any credential it does not carry filled
in from this machine's own environment — the same trust decision
`withHostCredentialFallback` makes explicit for `aai dev`, and right here
for the same reason: an eval runs on the developer's box against their own
key. A value passed in `env` always wins over the shell.

##### runCode?

```ts
readonly optional runCode?: RunCodeExecutor;
```

Backs the `run_code` builtin.

Without one the builtin is registered and permanently refuses, exactly as it
does off-platform — the Modal container is the security boundary and nothing
here pretends otherwise. What that COSTS was measured on the three tutor
templates: their headline feature was unevaluable, because the agent calls
`run_code`, reads "only available in the sandboxed runtime", and then does
the arithmetic in its head — so a case could asserted the CALL and never the
answer. An eval on a developer's own machine may supply an executor; a
deployed agent still cannot.

##### toolTimeoutMs?

```ts
readonly optional toolTimeoutMs?: number;
```

Per-tool-call deadline. Defaults to the session's own (30s, a voice-turn
budget). A tool whose work legitimately outruns that — a graded retrieval
loop making eleven model calls, measured at 22-30s — cannot otherwise be
evaluated at all: the executor answers a timeout and the case measures the
deadline instead of the agent.

##### turnTimeoutMs?

```ts
readonly optional turnTimeoutMs?: number;
```

##### workflows?

```ts
readonly optional workflows?: WorkflowClient;
```

`ctx.workflows` for this session — what a tool that starts a durable run
calls.

Without one, a workflow-declaring agent gets the client the runtime builds
over the Workflow DevKit, and every `start()` through it throws: the
compiler's transform never ran on a body imported through a test runner, so
`def.run.workflowId` is absent and there is nothing for the adapter to
start. That is a tool an eval cannot execute at all, which is the gap this
closes. Build one with `openEvalWorkflows({ agent })` and pass its `client`;
`describeEval` does that for you.

The engine under it is not durable — no journal, no replay, no retry. See
`eval/workflow-engine.ts` before writing a claim about a run.

***

### EvalSleep

```ts
type EvalSleep = {
  duration: string | number | Date;
  label: string;
};
```

One durable `sleep()` a body asked for — and did NOT take.

Recorded rather than waited out, because a suspension is the thing this engine
cannot reproduce and a real wait would only make a case slow while proving
nothing extra: `link-digest`'s ten seconds and the six hours its own comment
says the mechanism is identical at differ by nothing that runs here. What a
case CAN assert is that the body asked, and for how long.

#### Properties

##### duration

```ts
readonly duration: string | number | Date;
```

Exactly what the body passed `sleep()` — `"10 seconds"`, a number of ms, a date.

##### label

```ts
readonly label: string;
```

The wait's `label` — its identity in a real run's journal, and here the only
thing telling two of a body's waits apart.

A case asserting a SCHEDULE wants this: `podcast-digest` sleeps between
digests and again while polling, and a duration alone cannot say which of
them the body reached.

***

### EvalTextAgent

```ts
type EvalTextAgent = {
  id: string;
  close: Promise<void>;
  events: readonly (
     | {
     audioFormat: z.ZodString;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     sampleRate: z.ZodNumber;
     sessionId?: z.ZodOptional<z.ZodString>;
     ttsSampleRate: z.ZodNumber;
     type: z.ZodLiteral<"session.configured">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"audio.completed">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"speech.started">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"speech.stopped">;
   }
     | {
     eotConfidence?: z.ZodOptional<z.ZodNumber>;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     text: z.ZodString;
     type: z.ZodLiteral<"user-transcript.updated">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     text: z.ZodString;
     type: z.ZodLiteral<"user-transcript.committed">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     text: z.ZodString;
     type: z.ZodLiteral<"agent-transcript.updated">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     recovery?: z.ZodOptional<z.ZodEnum<{
        session-failed: "session-failed";
        turn-failed: "turn-failed";
     }>>;
     text: z.ZodString;
     type: z.ZodLiteral<"agent-transcript.committed">;
   }
     | {
     args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     toolCallId: z.ZodString;
     toolName: z.ZodString;
     type: z.ZodLiteral<"tool.called">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     result: z.ZodString;
     toolCallId: z.ZodString;
     type: z.ZodLiteral<"tool.completed">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"reply.completed">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"reply.cancelled">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"session.reset">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"session.timed-out">;
   }
     | {
     code: z.ZodEnum<{
        audio: "audio";
        connection: "connection";
        internal: "internal";
        llm: "llm";
        protocol: "protocol";
        stt: "stt";
        tool: "tool";
        tts: "tts";
     }>;
     fatal: z.ZodBoolean;
     message: z.ZodString;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"error.reported">;
   }
     | {
     data: z.ZodUnknown;
     event: z.ZodString;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     type: z.ZodLiteral<"custom.emitted">;
   }
     | {
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     state: z.ZodUnknown;
     type: z.ZodLiteral<"state.updated">;
   }
     | {
     messages: z.ZodArray<z.ZodObject<{
        content: z.ZodString;
        role: z.ZodEnum<{
           assistant: "assistant";
           user: "user";
        }>;
     }, z.core.$strip>>;
     meta: z.ZodObject<{
        at: z.ZodNumber;
        id: z.ZodString;
     }, z.core.$strip>;
     toolCalls: z.ZodArray<z.ZodObject<{
        afterMessageIndex: z.ZodNumber;
        args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        callId: z.ZodString;
        name: z.ZodString;
        result: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<{
           done: "done";
           pending: "pending";
        }>;
     }, z.core.$strip>>;
     type: z.ZodLiteral<"history.restored">;
  })[];
  said: readonly string[];
  send: Promise<EvalTurn>;
  sendAll: Promise<readonly EvalTurn[]>;
  toolCalls: readonly EvalToolCall[];
};
```

One live eval conversation with a text agent.

#### Methods

##### close()

```ts
close(): Promise<void>;
```

Release the conversation.

Nothing here owns a process-global registration or a live socket, so this
is a no-op today and is part of the surface anyway: a case's `try`/`finally`
is then the same shape as the voice harness's, and whoever installed a stub
model still owns releasing it.

###### Returns

`Promise`\<`void`\>

##### events()

```ts
events(): readonly (
  | {
  audioFormat: z.ZodString;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  sampleRate: z.ZodNumber;
  sessionId?: z.ZodOptional<z.ZodString>;
  ttsSampleRate: z.ZodNumber;
  type: z.ZodLiteral<"session.configured">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"audio.completed">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"speech.started">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"speech.stopped">;
}
  | {
  eotConfidence?: z.ZodOptional<z.ZodNumber>;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  text: z.ZodString;
  type: z.ZodLiteral<"user-transcript.updated">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  text: z.ZodString;
  type: z.ZodLiteral<"user-transcript.committed">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  text: z.ZodString;
  type: z.ZodLiteral<"agent-transcript.updated">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  recovery?: z.ZodOptional<z.ZodEnum<{
     session-failed: "session-failed";
     turn-failed: "turn-failed";
  }>>;
  text: z.ZodString;
  type: z.ZodLiteral<"agent-transcript.committed">;
}
  | {
  args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  toolCallId: z.ZodString;
  toolName: z.ZodString;
  type: z.ZodLiteral<"tool.called">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  result: z.ZodString;
  toolCallId: z.ZodString;
  type: z.ZodLiteral<"tool.completed">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"reply.completed">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"reply.cancelled">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"session.reset">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"session.timed-out">;
}
  | {
  code: z.ZodEnum<{
     audio: "audio";
     connection: "connection";
     internal: "internal";
     llm: "llm";
     protocol: "protocol";
     stt: "stt";
     tool: "tool";
     tts: "tts";
  }>;
  fatal: z.ZodBoolean;
  message: z.ZodString;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"error.reported">;
}
  | {
  data: z.ZodUnknown;
  event: z.ZodString;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"custom.emitted">;
}
  | {
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  state: z.ZodUnknown;
  type: z.ZodLiteral<"state.updated">;
}
  | {
  messages: z.ZodArray<z.ZodObject<{
     content: z.ZodString;
     role: z.ZodEnum<{
        assistant: "assistant";
        user: "user";
     }>;
  }, z.core.$strip>>;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  toolCalls: z.ZodArray<z.ZodObject<{
     afterMessageIndex: z.ZodNumber;
     args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
     callId: z.ZodString;
     name: z.ZodString;
     result: z.ZodOptional<z.ZodString>;
     status: z.ZodEnum<{
        done: "done";
        pending: "pending";
     }>;
  }, z.core.$strip>>;
  type: z.ZodLiteral<"history.restored">;
})[];
```

Every event this conversation has emitted, in stream order.

###### Returns

readonly (
  \| \{
  `audioFormat`: `z.ZodString`;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `sampleRate`: `z.ZodNumber`;
  `sessionId?`: `z.ZodOptional`\<`z.ZodString`\>;
  `ttsSampleRate`: `z.ZodNumber`;
  `type`: `z.ZodLiteral`\<`"session.configured"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"audio.completed"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"speech.started"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"speech.stopped"`\>;
\}
  \| \{
  `eotConfidence?`: `z.ZodOptional`\<`z.ZodNumber`\>;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `text`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"user-transcript.updated"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `text`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"user-transcript.committed"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `text`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"agent-transcript.updated"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `recovery?`: `z.ZodOptional`\<`z.ZodEnum`\<\{
     `session-failed`: `"session-failed"`;
     `turn-failed`: `"turn-failed"`;
  \}\>\>;
  `text`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"agent-transcript.committed"`\>;
\}
  \| \{
  `args`: `z.ZodRecord`\<`z.ZodString`, `z.ZodUnknown`\>;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `toolCallId`: `z.ZodString`;
  `toolName`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"tool.called"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `result`: `z.ZodString`;
  `toolCallId`: `z.ZodString`;
  `type`: `z.ZodLiteral`\<`"tool.completed"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"reply.completed"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"reply.cancelled"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"session.reset"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"session.timed-out"`\>;
\}
  \| \{
  `code`: `z.ZodEnum`\<\{
     `audio`: `"audio"`;
     `connection`: `"connection"`;
     `internal`: `"internal"`;
     `llm`: `"llm"`;
     `protocol`: `"protocol"`;
     `stt`: `"stt"`;
     `tool`: `"tool"`;
     `tts`: `"tts"`;
  \}\>;
  `fatal`: `z.ZodBoolean`;
  `message`: `z.ZodString`;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"error.reported"`\>;
\}
  \| \{
  `data`: `z.ZodUnknown`;
  `event`: `z.ZodString`;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `type`: `z.ZodLiteral`\<`"custom.emitted"`\>;
\}
  \| \{
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `state`: `z.ZodUnknown`;
  `type`: `z.ZodLiteral`\<`"state.updated"`\>;
\}
  \| \{
  `messages`: `z.ZodArray`\<`z.ZodObject`\<\{
     `content`: `z.ZodString`;
     `role`: `z.ZodEnum`\<\{
        `assistant`: `"assistant"`;
        `user`: `"user"`;
     \}\>;
  \}, `z.core.$strip`\>\>;
  `meta`: `z.ZodObject`\<\{
     `at`: `z.ZodNumber`;
     `id`: `z.ZodString`;
  \}, `z.core.$strip`\>;
  `toolCalls`: `z.ZodArray`\<`z.ZodObject`\<\{
     `afterMessageIndex`: `z.ZodNumber`;
     `args`: `z.ZodRecord`\<`z.ZodString`, `z.ZodUnknown`\>;
     `callId`: `z.ZodString`;
     `name`: `z.ZodString`;
     `result`: `z.ZodOptional`\<`z.ZodString`\>;
     `status`: `z.ZodEnum`\<\{
        `done`: `"done"`;
        `pending`: `"pending"`;
     \}\>;
  \}, `z.core.$strip`\>\>;
  `type`: `z.ZodLiteral`\<`"history.restored"`\>;
\})[]

##### said()

```ts
said(): readonly string[];
```

Every committed reply so far.

Unlike a session's, this does NOT open with a greeting: `createTextAgent`
has no greeting turn at all, so an `agent()` definition's `greeting` — which
every definition carries, the factory defaulting it — is dropped in text
mode. A case ported from the voice harness is off by one turn until it
stops accounting for one.

###### Returns

readonly `string`[]

##### send()

```ts
send(text: string): Promise<EvalTurn>;
```

Send a user message, wait for the reply to END, and hand back that turn.

The wait is `await`ing the turn's own stream rather than a timer — see the
module doc — so the next `send()` cannot begin inside this turn and a
recorded tool order is the agent's.

###### Parameters

###### text

`string`

###### Returns

`Promise`\<[`EvalTurn`](#evalturn)\>

###### Throws

when nothing about the AGENT can be read off the turn: the model
  stream failed, or a tool was called that the agent has no definition for.
  Both states are measured PASSING otherwise, because a text agent commits
  no transcript on a failed turn and every negative claim then holds
  vacuously. Such a turn is NOT appended to the conversation, so a case
  that catches the throw does not carry it into the next `send()`;
  [EvalTextAgent.events](#events-1) is unaffected and holds what happened.

##### sendAll()

```ts
sendAll(lines: readonly string[]): Promise<readonly EvalTurn[]>;
```

Send every line in order, waiting out each reply, and hand back every turn.

Strictly sequential, like the person it stands for, and ONE conversation:
each line is sent with every earlier turn's messages in front of it.

Assert about the turn a MECHANISM fired in, never about turn number two —
how many turns an agent takes to get somewhere is the model's business and
it measurably varies. `turnCalling`, `toolCallsInTurns` and `describeTurn`
(`eval/turns.ts`) are what read the result without pinning an index, and
they take these turns unchanged.

###### Parameters

###### lines

readonly `string`[]

###### Returns

`Promise`\<readonly [`EvalTurn`](#evalturn)[]\>

##### toolCalls()

```ts
toolCalls(): readonly EvalToolCall[];
```

The tool calls so far, in call order, each with its result.

###### Returns

readonly [`EvalToolCall`](#evaltoolcall)[]

#### Properties

##### id

```ts
readonly id: string;
```

This conversation's id — what its tools read as `ctx.sessionId`.

Exposed for the reason `EvalSession.id` is: it is what a tool
CORRELATES a durable run with, so a case asserting "the run it started is
this conversation's" needs both halves.

***

### EvalTextAgentOptions

```ts
type EvalTextAgentOptions = {
  agent: AgentDef;
  env?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  llm?: LlmProvider;
  logger?: Logger;
  providerEnv?: ProviderEnv;
  runCode?: RunCodeExecutor;
  toolTimeoutMs?: number;
  turnTimeoutMs?: number;
  workflows?: WorkflowClient;
};
```

What [openEvalTextAgent](#openevaltextagent) takes.

#### Properties

##### agent

```ts
readonly agent: AgentDef;
```

The agent under eval. Must declare `text: true`.

##### env?

```ts
readonly optional env?: Record<string, string>;
```

The agent's own env, i.e. what its tools read as `ctx.env`. Defaults to
empty: a tool that needs a value gets it here, and nothing is inherited
implicitly.

##### fetch?

```ts
readonly optional fetch?: typeof globalThis.fetch;
```

The `fetch` the builtin web tools use. Pass one to keep a case off the
network — a scripted `visit_webpage` really visits.

##### llm?

```ts
readonly optional llm?: LlmProvider;
```

Override the LLM the case runs on. Defaults to the agent's own.

A DESCRIPTOR rather than a resolved `LanguageModel`, and it is spread onto
the definition rather than passed as `createTextAgent`'s `model`, so the
override reaches `ctx.generate` and `ctx.delegate` as well as the turns —
see the module doc on why that is what makes the keyless fallback honest.

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to silent. Pass `consoleLogger` when diagnosing a case.

##### providerEnv?

```ts
readonly optional providerEnv?: ProviderEnv;
```

Where provider credentials are resolved from. Defaults to
[EvalTextAgentOptions.env](#env-2) with any credential it does not carry
filled in from this machine's own environment — the same trust decision
`openEvalSession` makes, for the same reason: an eval runs on the
developer's box against their own key. A value passed in `env` always wins
over the shell.

##### runCode?

```ts
readonly optional runCode?: RunCodeExecutor;
```

Backs the `run_code` builtin. Without one the builtin is registered and
permanently refuses, exactly as it does off-platform — the Modal container
is the security boundary and nothing here pretends otherwise.

##### toolTimeoutMs?

```ts
readonly optional toolTimeoutMs?: number;
```

Per-tool-call deadline. Defaults to the executor's own (30s, a voice-turn
budget), which a text agent whose tools type-check a workspace or install
packages will outrun — and then the case measures the deadline instead of
the agent.

##### turnTimeoutMs?

```ts
readonly optional turnTimeoutMs?: number;
```

How long one turn may take before it is cancelled. Defaults to 90s.

##### workflows?

```ts
readonly optional workflows?: WorkflowClient;
```

`ctx.workflows` for this conversation — what a tool that starts a run calls.

***

### EvalToolCall

```ts
type EvalToolCall = {
  args: Record<string, unknown>;
  name: string;
  result?: string;
  toolCallId: string;
};
```

One tool call, paired with its result when the stream carries one.

#### Properties

##### args

```ts
readonly args: Record<string, unknown>;
```

##### name

```ts
readonly name: string;
```

##### result?

```ts
readonly optional result?: string;
```

The serialized result, or undefined when the call never completed.

##### toolCallId

```ts
readonly toolCallId: string;
```

***

### EvalTurn

```ts
type EvalTurn = {
  completed: boolean;
  events: readonly SessionEvent[];
  text: string;
  toolCalls: readonly EvalToolCall[];
};
```

One turn: what the agent did between an utterance and the end of its reply.

`say()` hands one back because "on that turn" is most of the meaning of almost
every claim an eval makes. `calledTool("get_weather")` over a whole call is a
much weaker statement than the same thing about the reply to one question, and
a whole-run reader cannot express the stronger one without hand-slicing the
event list — which is how an eval comes to assert against the GREETING, a real
turn that lands in `said()` before the case has said anything at all.

#### Properties

##### completed

```ts
readonly completed: boolean;
```

The reply ended on its own terms (`reply.completed`) rather than being
cancelled. A cancelled reply is a finding, not a failure of the harness.

##### events

```ts
readonly events: readonly SessionEvent[];
```

This turn's events, from the committed utterance to the terminator.

##### text

```ts
readonly text: string;
```

The agent's committed reply, joined — what the caller was told.

##### toolCalls

```ts
readonly toolCalls: readonly EvalToolCall[];
```

This turn's tool calls, in call order, each with its result.

***

### EvalWorkflowEngineOptions

```ts
type EvalWorkflowEngineOptions = {
  env: Readonly<Record<string, string>>;
  speech?: SpeechSynthesizer;
  stepFetch?: StepFetch;
  workflows: Readonly<Record<string, WorkflowDef>>;
};
```

How the in-process engine behind `openEvalWorkflows` is configured.

Public because [EvalWorkflowsOptions](#evalworkflowsoptions) indexes into it for its `speech`
and `stepFetch` fields — the engine factory itself stays internal, so this
describes the shape rather than naming it.

#### Properties

##### env

```ts
readonly env: Readonly<Record<string, string>>;
```

The agent env a step reads with `stepEnv`/`requireStepEnv`.

Published rather than left to `process.env`, which is what an unpublished
slot falls back to: publishing is what makes a step read exactly the keys the
agent declares, in an eval as in a deployment.

##### speech?

```ts
readonly optional speech?: SpeechSynthesizer;
```

A speech synthesizer to publish, for a flow whose step calls `stepSpeak`.

Nothing by default, so an unpublished slot fails by name — which is the
SDK's own behaviour and the right one: there is no global synthesizer to
fall back to. A case supplies `installStubSpeech`
(`@alexkroman1/aai/testing/vitest`); a host wanting the real socket passes
`speakOverWebSocket`, which is not named here for the same graph reason as
[EvalWorkflowEngineOptions.stepFetch](#stepfetch).

##### stepFetch?

```ts
readonly optional stepFetch?: StepFetch;
```

A `stepFetch` to publish for this app's steps. Nothing is published by
default, which means a step's HTTP falls back to `globalThis.fetch`.

**Taken as a VALUE rather than built here, and that is a graph decision
rather than a style one.** `createStepFetch` reaches `undici`, and naming it
from this module put the runtime's whole step graph into the program of
every package whose eval file imports `/eval/vitest` — which is
`aai-templates`, where it failed on an unrelated `BodyInit` mismatch under
`exactOptionalPropertyTypes`. That is the hazard
`packages/aai-runtime/CLAUDE.md` records for `host-internal`, arriving by a
new route. A host that wants the pooled HTTP/1.1 fetch passes its own; a
template eval does not need one.

The cost, stated: `globalThis.fetch` offers `h2` in ALPN, so a WIDE live
fan-out through it can collect stream resets a pooled HTTP/1.1 fetch would
not (`sdk/step-fetch.ts` has the measurements). An eval is not where a
fan-out's concurrency is measured, and the upside is that BOTH published
fakes work — `installStubGateway` over the global, and
`installStubStepFetch` / `installStubTranscribe` over the slot.

##### workflows

```ts
readonly workflows: Readonly<Record<string, WorkflowDef>>;
```

The agent's declared workflows, keyed as `agent({ workflows })` keys them.

***

### EvalWorkflowRun

```ts
type EvalWorkflowRun<R = unknown> = {
  completed: boolean;
  elapsedMs: number | undefined;
  emitted: readonly EvalEmitted[];
  error: string | undefined;
  key: string | undefined;
  output: R | undefined;
  reported: readonly string[];
  runId: string;
  slept: readonly EvalSleep[];
  snapshot: WorkflowRunSnapshot<R>;
  status: WorkflowRunStatus;
  workflow: string;
};
```

What one eval run did.

#### Type Parameters

##### R

`R` = `unknown`

#### Properties

##### completed

```ts
readonly completed: boolean;
```

`status === "completed"` — the run ended on its own terms.

##### elapsedMs

```ts
readonly elapsedMs: number | undefined;
```

Wall clock of the body, once it has settled.

##### emitted

```ts
readonly emitted: readonly EvalEmitted[];
```

Every chunk this run's steps wrote with `stepEmit()`, oldest first.

##### error

```ts
readonly error: string | undefined;
```

The failure message, for a run that failed.

##### key

```ts
readonly key: string | undefined;
```

The CORRELATION key the caller started this run under, when it named one.

A voice tool that hands off to a run correlates it with something it can
find again — `ctx.sessionId`, an order id — and "did it correlate the run"
is a claim an eval wants to make DIRECTLY. Without this it was provable only
by having a later turn find the run again, which is a weaker statement
about a longer chain. It is the same field the production snapshot carries,
so a case reads what a page would.

##### output

```ts
readonly output: R | undefined;
```

What the body returned, for a run that completed.

Flat and possibly `undefined` because that is what an assertion reads best;
[EvalWorkflowRun.snapshot](#snapshot) is the same fact as the discriminated union
the production client answers with, for a case that wants the narrowing.

##### reported

```ts
readonly reported: readonly string[];
```

Every line this run's steps wrote with `stepReport()`, oldest first.

##### runId

```ts
readonly runId: string;
```

##### slept

```ts
readonly slept: readonly EvalSleep[];
```

Every durable `sleep()` the body asked for — recorded, never waited out.
See [EvalSleep](#evalsleep): a suspension is the thing this cannot reproduce, so
the honest report is what was asked for.

##### snapshot

```ts
readonly snapshot: WorkflowRunSnapshot<R>;
```

What `ctx.workflows.get(runId)` answered — the production union.

##### status

```ts
readonly status: WorkflowRunStatus;
```

##### workflow

```ts
readonly workflow: string;
```

The key the workflow is declared under in `agent({ workflows })`.

***

### EvalWorkflows

```ts
type EvalWorkflows = {
  client: WorkflowClient;
  close: Promise<void>;
  run: Promise<EvalWorkflowRun<R>>;
  runs: Promise<readonly EvalWorkflowRun<unknown>[]>;
  settle: Promise<EvalWorkflowRun<R>>;
  settleAll: Promise<readonly EvalWorkflowRun<unknown>[]>;
};
```

One open eval workflow app.

#### Methods

##### close()

```ts
close(): Promise<void>;
```

Unpublish the step slots and release the engine. Never rejects.

**It does NOT wait for a run still in flight, and it says so out loud when
there is one** — a `process.emitWarning` naming the run and pointing at
[EvalWorkflows.settleAll](#settleall). Draining here could only deadlock and
abandoning silently is the leak; `eval/_workflow-drain.ts` argues all three
options.

###### Returns

`Promise`\<`void`\>

##### run()

###### Call Signature

```ts
run<P extends ToolInputSchema, R>(
   workflow: WorkflowDef<P, R>, 
   input: InferSchemaOutput<P>, 
   options?: EvalRunOptions
): Promise<EvalWorkflowRun<R>>;
```

Start a run and wait for it to settle.

###### Type Parameters

###### P

`P` *extends* [`ToolInputSchema`](../aai/index.md#toolinputschema)

###### R

`R`

###### Parameters

###### workflow

[`WorkflowDef`](../aai/index.md#workflowdef)\<`P`, `R`\>

###### input

[`InferSchemaOutput`](../aai/index.md#inferschemaoutput)\<`P`\>

###### options?

[`EvalRunOptions`](#evalrunoptions)

###### Returns

`Promise`\<[`EvalWorkflowRun`](#evalworkflowrun)\<`R`\>\>

###### Call Signature

```ts
run(
   workflow: string, 
   input?: unknown, 
   options?: EvalRunOptions
): Promise<EvalWorkflowRun<unknown>>;
```

###### Parameters

###### workflow

`string`

###### input?

`unknown`

###### options?

[`EvalRunOptions`](#evalrunoptions)

###### Returns

`Promise`\<[`EvalWorkflowRun`](#evalworkflowrun)\<`unknown`\>\>

##### runs()

```ts
runs(): Promise<readonly EvalWorkflowRun<unknown>[]>;
```

Every run this app has started, oldest first, without waiting for any.

###### Returns

`Promise`\<readonly [`EvalWorkflowRun`](#evalworkflowrun)\<`unknown`\>[]\>

##### settle()

###### Call Signature

```ts
settle<R>(
   runId: string, 
   workflow: AnyWorkflowDef<R>, 
   options?: {
  timeoutMs?: number;
}
): Promise<EvalWorkflowRun<R>>;
```

Wait for a run somebody ELSE started — a tool, in a voice eval — and read it.

###### Type Parameters

###### R

`R`

###### Parameters

###### runId

`string`

###### workflow

[`AnyWorkflowDef`](../aai/workflow-api.md#anyworkflowdef)\<`R`\>

###### options?

###### timeoutMs?

`number`

###### Returns

`Promise`\<[`EvalWorkflowRun`](#evalworkflowrun)\<`R`\>\>

###### Throws

if this app never started `runId`, which is the honest answer: the
  engine is the only thing that can have run it.

###### Call Signature

```ts
settle(
   runId: string, 
   workflow?: undefined, 
   options?: {
  timeoutMs?: number;
}
): Promise<EvalWorkflowRun<unknown>>;
```

###### Parameters

###### runId

`string`

###### workflow?

`undefined`

###### options?

###### timeoutMs?

`number`

###### Returns

`Promise`\<[`EvalWorkflowRun`](#evalworkflowrun)\<`unknown`\>\>

##### settleAll()

```ts
settleAll(options?: {
  timeoutMs?: number;
}): Promise<readonly EvalWorkflowRun<unknown>[]>;
```

Wait for every run this app has started, oldest first, and read them all.

**Not tidiness — a LEAK.** Two shipped templates hand-rolled this loop
verbatim, and `recap-workflow`'s doc says why: the scripted provider a case
installs is unpublished when that case finishes, so a body still mid-flight
makes its next request "against whatever the next case publishes — or
against the real provider, with a real key".

The half that stays the CASE's is the release: what holds a run in flight is
a gate of the case's own, and nothing here can open one. So the shape is
`release(); await app.settleAll();`. A run started WHILE this drains is
drained too, and `timeoutMs` bounds each run rather than the set. See
`eval/_workflow-drain.ts` for the whole argument, including what
[EvalWorkflows.close](#close-2) does when this is not called.

###### Parameters

###### options?

###### timeoutMs?

`number`

###### Returns

`Promise`\<readonly [`EvalWorkflowRun`](#evalworkflowrun)\<`unknown`\>[]\>

#### Properties

##### client

```ts
readonly client: WorkflowClient;
```

The real `ctx.workflows` for this agent, over the in-process engine.

Hand it to `openEvalSession({ workflows })` and a voice agent's tool that
starts, finds or cancels a run works in an eval — which is what
`research-workflow` and `recap-workflow` need and could not have.

***

### EvalWorkflowsOptions

```ts
type EvalWorkflowsOptions = {
  agent: AgentDef;
  env?: Record<string, string>;
  logger?: Logger;
  speech?: EvalWorkflowEngineOptions["speech"];
  stepFetch?: EvalWorkflowEngineOptions["stepFetch"];
  timeoutMs?: number;
};
```

What [openEvalWorkflows](#openevalworkflows) takes.

#### Properties

##### agent

```ts
readonly agent: AgentDef;
```

The agent under eval — an ordinary `agent()` or `workflowApp()` definition.

##### env?

```ts
readonly optional env?: Record<string, string>;
```

The agent env a step reads with `stepEnv` / `requireStepEnv`.

Defaults to what [evalWorkflowCredentials](#evalworkflowcredentials) found on this machine, which
is the same trust decision `openEvalSession` makes for its provider env and
right for the same reason: an eval runs on the developer's box against their
own key. A value passed here always wins.

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to silent. Pass `consoleLogger` when diagnosing a case.

##### speech?

```ts
readonly optional speech?: EvalWorkflowEngineOptions["speech"];
```

A speech synthesizer to publish, for a flow whose step calls `stepSpeak` —
nothing by default. See [EvalWorkflowEngineOptions.speech](#speech).

##### stepFetch?

```ts
readonly optional stepFetch?: EvalWorkflowEngineOptions["stepFetch"];
```

A `stepFetch` to publish for this app's steps — nothing by default, so a
step's HTTP falls back to `globalThis.fetch`.

Taken as a value rather than built here, and the reason is a MODULE GRAPH
one that a reader would otherwise undo: see
[EvalWorkflowEngineOptions.stepFetch](#stepfetch).

##### timeoutMs?

```ts
readonly optional timeoutMs?: number;
```

Overrides the default per-run timeout for every run of this app.

***

### HostGenerateFn

```ts
type HostGenerateFn = (options: GenerateOptions, callOptions?: {
  signal?: AbortSignal;
}) => Promise<GenerateResult>;
```

The host-side `ctx.generate` implementation — takes `GenerateOptions` and
resolves a `GenerateResult`, with an extra per-call options bag: the tool
executor binds the issuing turn's abort signal so an in-flight generation
stops on barge-in / reset / session stop.

Public because `EvalSessionOptions.generate` takes one: substituting the
in-tool LLM call is how a case asserts on what a tool DID without paying for
a second live model, and an option whose type has no name is an option a
spec can pass and not hold in a variable. It was `@internal` while nothing
published a field of this type.

#### Parameters

##### options

[`GenerateOptions`](../aai/index.md#generateoptions)

##### callOptions?

###### signal?

`AbortSignal`

#### Returns

`Promise`\<[`GenerateResult`](../aai/index.md#generateresult)\>

***

### LogContext

```ts
type LogContext = Record<string, unknown>;
```

Structured context attached to a log line.

***

### LogFn

```ts
type LogFn = (message: string, ctx?: LogContext) => void;
```

A single log method: message plus optional structured context.

#### Parameters

##### message

`string`

##### ctx?

[`LogContext`](#logcontext)

#### Returns

`void`

***

### Logger

```ts
type Logger = Record<LogLevel, LogFn>;
```

Structured logger interface. Used by tests to suppress output and by
consumers to plug in custom logging backends.

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { createRuntime, type Logger } from "@alexkroman1/aai-runtime";
declare const myBackend: { log(level: string, message: string, ctx?: object): void };

const myLogger: Logger = {
  info: (message, ctx) => myBackend.log("info", message, ctx),
  warn: (message, ctx) => myBackend.log("warn", message, ctx),
  error: (message, ctx) => myBackend.log("error", message, ctx),
  debug: (message, ctx) => myBackend.log("debug", message, ctx),
};
createRuntime({ agent: agent({ name: "My Agent" }), env: {}, logger: myLogger });
```

***

### LogLevel

```ts
type LogLevel = "info" | "warn" | "error" | "debug";
```

Log severity levels a [Logger](#logger-3) implements.

***

### RunCodeExecutor

```ts
type RunCodeExecutor = (code: string) => Promise<
  | string
  | {
  error: string;
}>;
```

In-sandbox executor backing the run_code builtin (see createRunCode).

#### Parameters

##### code

`string`

#### Returns

`Promise`\<
  \| `string`
  \| \{
  `error`: `string`;
\}\>

***

### StubLlm

```ts
type StubLlm = {
  env: Record<string, string>;
  llm: LlmProvider;
  release: void;
};
```

A registered stub model, and what to hand a session.

#### Methods

##### release()

```ts
release(): void;
```

Unregister the kind. Every install owes one.

###### Returns

`void`

#### Properties

##### env

```ts
readonly env: Record<string, string>;
```

Merge into the session's provider env.

##### llm

```ts
readonly llm: LlmProvider;
```

Pass as [EvalSessionOptions.llm](#llm).

***

### StubScript

```ts
type StubScript = string | readonly (string | StubStep)[];
```

What a scripted model is given: one line, or a sequence of steps.

***

### StubSpeechProviders

```ts
type StubSpeechProviders = {
  env: Record<string, string>;
  stt: SttProvider;
  tts: TtsProvider;
  release: void;
  sttSession: StubSttSession | undefined;
  ttsSession: StubTtsSession | undefined;
};
```

Both fake stages, registered, with the handles a case needs.

`release()` unregisters the kinds. Kinds are UNIQUE per install (the registry
is process-global and a session may outlive the case that opened it), so two
concurrent eval sessions cannot serve each other's transcripts.

#### Methods

##### release()

```ts
release(): void;
```

###### Returns

`void`

##### sttSession()

```ts
sttSession(): StubSttSession | undefined;
```

The most recently opened STT stream, once the session has started.

###### Returns

[`StubSttSession`](#stubsttsession) \| `undefined`

##### ttsSession()

```ts
ttsSession(): StubTtsSession | undefined;
```

The most recently opened TTS stream, once the session has started.

###### Returns

[`StubTtsSession`](#stubttssession) \| `undefined`

#### Properties

##### env

```ts
readonly env: Record<string, string>;
```

Merge into the runtime env: the fake stages resolve a credential too.

##### stt

```ts
readonly stt: SttProvider;
```

##### tts

```ts
readonly tts: TtsProvider;
```

***

### StubStep

```ts
type StubStep = 
  | {
  text: string;
}
  | {
  args?: Record<string, unknown>;
  tool: string;
};
```

One step of a scripted model: a line it says, or a tool it calls.

A bare string is the line — the common case, and what most cases need. The
tool form is what makes a stub run worth having for an agent that HAS tools:
without it, every case asserting a tool call would have to be `{ live: true }`
and would be skipped in exactly the environment that cannot have a key.

***

### StubSttSession

```ts
type StubSttSession = SttSession & {
  commit: void;
  partial: void;
};
```

One open fake STT stream, plus the two edges a case drives.

#### Type Declaration

##### commit()

```ts
commit(text: string): void;
```

Emit the committed turn — the cue the pipeline runs the LLM on.

###### Parameters

###### text

`string`

###### Returns

`void`

##### partial()

```ts
partial(text: string): void;
```

Emit an interim transcript.

###### Parameters

###### text

`string`

###### Returns

`void`

***

### StubTtsSession

```ts
type StubTtsSession = TtsSession & {
  spoken: readonly string[];
};
```

One open fake TTS stream, plus what it captured.

#### Type Declaration

##### spoken

```ts
readonly spoken: readonly string[];
```

Every text chunk the pipeline handed to TTS, in order.

***

### VmRunCodeOptions

```ts
type VmRunCodeOptions = {
  globals?: Record<string, unknown>;
  timeoutMs?: number;
};
```

What [createVmRunCode](#createvmruncode) takes.

#### Properties

##### globals?

```ts
readonly optional globals?: Record<string, unknown>;
```

Extra globals the evaluated code may see, merged over the capturing
`console`.

Every entry is a CAPABILITY GRANT into a context that can reach the host
realm through any object it is handed, so add one deliberately. The default
is `console.log` and nothing else, which is what the four templates needed
and the smallest thing that makes an answer readable.

##### timeoutMs?

```ts
readonly optional timeoutMs?: number;
```

Wall-clock budget for one evaluation, in milliseconds. Defaults to 1000.

A `while (true) {}` is a thing a model emits, and without this the case
hangs to the suite deadline and reads as a broken harness.

## Variables

### DEFAULT\_RUN\_TIMEOUT\_MS

```ts
const DEFAULT_RUN_TIMEOUT_MS: 300000 = 300000;
```

How long one run may take before the harness gives up on it.

Generous next to a session turn's 90s, because a workflow is the shape of work
that does not fit in a turn — a fan-out over sixty segments, seven long-form
model calls — and the eval tier's own budget is 1800s.

***

### STUB\_LLM\_API\_KEY\_ENV

```ts
const STUB_LLM_API_KEY_ENV: "AAI_EVAL_STUB_LLM_KEY" = "AAI_EVAL_STUB_LLM_KEY";
```

The env var the stub model resolves its (unused) credential from.

***

### STUB\_SPEECH\_API\_KEY\_ENV

```ts
const STUB_SPEECH_API_KEY_ENV: "AAI_EVAL_FAKE_SPEECH_KEY" = "AAI_EVAL_FAKE_SPEECH_KEY";
```

The env var the fake stages resolve their (unused) credential from.

***

### TURN\_ENDS

```ts
const TURN_ENDS: ReadonlySet<SessionEvent["type"]>;
```

The events that END a reply.

Declared ONCE, because two things must agree by construction: they partition
a run into turns for anything reading [toolCallsInEvents](#toolcallsinevents) per reply, and they
are what `openEvalSession`'s `say()` waits for. The set used to be written out
in two files, and a third terminator added to one copy would make `say()`
return mid-reply while the assertions still thought the turn was open — which
reads as the agent misbehaving rather than as a harness bug.
