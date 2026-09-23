# eval/simulate

`@alexkroman1/aai-runtime/eval/simulate` — a simulated caller, and a
model-graded judge.

[simulateCall](#simulatecall) has a SECOND model play the caller — a persona and a
goal — driving the same `say()`/`send()` a scripted case does until it calls
`end_call` or `maxTurns` runs out. The result is ordinary `EvalTurn`s plus
the call's metrics, so every reader on `@alexkroman1/aai-runtime/eval` takes
it unchanged. [judgeCall](#judgecall) rules on each criterion over a call, a list
of turns or a transcript, and computes the verdict from those rulings rather
than asking for one. Deterministic readers stay the first instrument; a judge
is for the claims only visible as meaning, and it is a noisy one — run it
under `AAI_EVAL_REPEAT` and read the spread.

In a `describeEval` / `describeTextEval` case, [evalSimulation](#evalsimulation) builds
the pair from the case's own `session` and `mode`, live or scripted the way
the rest of the suite is:

```ts
import type { AgentDef } from "@alexkroman1/aai";
import { evalSimulation } from "@alexkroman1/aai-runtime/eval/simulate";
import type { EvalTestContext } from "@alexkroman1/aai-runtime/eval/vitest";

declare const agentDef: AgentDef;

// The body of a `describeEval` case: `session` and `mode` come from its context.
export async function forecastCase({ session, mode }: EvalTestContext): Promise<boolean> {
  const { simulate, judge } = evalSimulation({ agent: agentDef, mode, target: session });
  const call = await simulate({ persona: "a commuter", goal: "the forecast" });
  return (await judge(call, ["It answered the question."])).pass;
}
```

Its own subpath and capability rather than names on `/eval` and fields on the
case context: the harness a case runs in and the second and third models a
simulation adds move for unrelated reasons, and one epoch for both would
version neither honestly. Runner-free, like `/eval`.

Exports are enumerated explicitly (no `export *`) so the public surface is
deliberate.

## Functions

### evalSimulation()

```ts
function evalSimulation(settings: EvalSimulationOptions): EvalSimulationContext;
```

Build the `simulate`/`judge` pair for one case. Every stub it installs is
released before the call that installed it returns, so a case owes nothing
back.

#### Parameters

##### settings

[`EvalSimulationOptions`](#evalsimulationoptions)

#### Returns

[`EvalSimulationContext`](#evalsimulationcontext)

***

### judgeCall()

```ts
function judgeCall(input: JudgeInput, options: JudgeCallOptions): Promise<CallVerdict>;
```

Have a model rule on `criteria` over `input`, and hand back the verdict.

```ts
import { llm } from "@alexkroman1/aai/llm";
import { judgeCall, type SimulatedCall } from "@alexkroman1/aai-runtime/eval/simulate";

export async function grade(call: SimulatedCall): Promise<void> {
  const verdict = await judgeCall(call, {
    criteria: [
      "The agent looked the order up before saying whether it shipped.",
      "The agent never asked for a card number.",
    ],
    llm: llm({ provider: "anthropic", model: "claude-sonnet-5" }),
  });
  if (!verdict.pass) throw new Error(verdict.explain());
}
```

#### Parameters

##### input

[`JudgeInput`](#judgeinput)

##### options

[`JudgeCallOptions`](#judgecalloptions)

#### Returns

`Promise`\<[`CallVerdict`](#callverdict)\>

#### Throws

if `criteria` is empty — a judge with nothing to rule on passes
  vacuously, which is the silent green this module exists not to produce.

***

### simulateCall()

```ts
function simulateCall(target: SimulationTarget, options: SimulateCallOptions): Promise<SimulatedCall>;
```

Run a simulated call against `target` and hand back every turn, the way it
ended, and what was measured.

```ts
import { agent } from "@alexkroman1/aai";
import { llm } from "@alexkroman1/aai/llm";
import { openEvalSession } from "@alexkroman1/aai-runtime/eval";
import { simulateCall } from "@alexkroman1/aai-runtime/eval/simulate";

export async function hurriedCaller(): Promise<void> {
  const session = await openEvalSession({ agent: agent({ name: "Order Desk" }) });
  try {
    const call = await simulateCall(session, {
      caller: {
        persona: "a polite but hurried customer",
        goal: "find out whether order W1234 has shipped",
      },
      llm: llm({ provider: "anthropic", model: "claude-haiku-4-5" }),
    });
    if (call.endedBy !== "caller") throw new Error(call.transcript());
    console.log(call.metrics.toolCallCounts, call.metrics.latencyMs);
  } finally {
    await session.close();
  }
}
```

The target is used as is and left OPEN — whoever opened it closes it, the
same ownership every other door here keeps.

#### Parameters

##### target

[`SimulationTarget`](#simulationtarget)

##### options

[`SimulateCallOptions`](#simulatecalloptions)

#### Returns

`Promise`\<[`SimulatedCall`](#simulatedcall)\>

## Type Aliases

### CallVerdict

```ts
type CallVerdict = {
  criteria: readonly CriterionVerdict[];
  pass: boolean;
  scripted: boolean;
  summary: string;
  explain: string;
};
```

The judge's verdict over a whole conversation.

#### Methods

##### explain()

```ts
explain(): string;
```

The failed rulings, one per line — what a failure message should print.

###### Returns

`string`

#### Properties

##### criteria

```ts
readonly criteria: readonly CriterionVerdict[];
```

One ruling per criterion, in the order they were given.

##### pass

```ts
readonly pass: boolean;
```

Every criterion passed.

##### scripted

```ts
readonly scripted: boolean;
```

The rulings came from a script (`stubJudge`), not a model's reading.

##### summary

```ts
readonly summary: string;
```

The judge's overall summary.

***

### CriterionVerdict

```ts
type CriterionVerdict = {
  criterion: string;
  pass: boolean;
  reason: string;
};
```

One criterion's ruling.

#### Properties

##### criterion

```ts
readonly criterion: string;
```

##### pass

```ts
readonly pass: boolean;
```

##### reason

```ts
readonly reason: string;
```

The judge's reason, in a sentence or two.

***

### EvalSimulationContext

```ts
type EvalSimulationContext = {
  judge: Promise<CallVerdict>;
  simulate: Promise<SimulatedCall>;
};
```

What a case gets for running a simulated caller and grading the result.

#### Methods

##### judge()

```ts
judge(
   input: JudgeInput, 
   criteria: readonly string[], 
   options?: {
  context?: string;
}
): Promise<CallVerdict>;
```

Have a model rule on `criteria` over a simulated call, a list of turns, or
a transcript. See `judgeCall`.

###### Parameters

###### input

[`JudgeInput`](#judgeinput)

###### criteria

readonly `string`[]

###### options?

###### context?

`string`

###### Returns

`Promise`\<[`CallVerdict`](#callverdict)\>

##### simulate()

```ts
simulate(caller: SimulatedCaller, options?: {
  maxTurns?: number;
}): Promise<SimulatedCall>;
```

Run a simulated caller against this case's session (or text agent) until
it hangs up or `maxTurns` runs out. See `simulateCall`.

###### Parameters

###### caller

[`SimulatedCaller`](#simulatedcaller)

###### options?

###### maxTurns?

`number`

###### Returns

`Promise`\<[`SimulatedCall`](#simulatedcall)\>

***

### EvalSimulationOptions

```ts
type EvalSimulationOptions = {
  agent: AgentDef;
  callerLlm?: LlmProvider;
  env?: Record<string, string>;
  judgeLlm?: LlmProvider;
  llm?: LlmProvider;
  mode: EvalMode;
  providerEnv?: ProviderEnv;
  stubCaller?: StubScript;
  stubJudge?: readonly boolean[];
  target: SimulationTarget;
};
```

What [evalSimulation](#evalsimulation) takes.

#### Properties

##### agent

```ts
readonly agent: AgentDef;
```

The agent under evaluation. Live, the caller and the judge default to its model.

##### callerLlm?

```ts
readonly optional callerLlm?: LlmProvider;
```

The model that PLAYS the caller when live. Defaults to the agent's model.

##### env?

```ts
readonly optional env?: Record<string, string>;
```

The agent env, for live credentials. Defaults to none.

##### judgeLlm?

```ts
readonly optional judgeLlm?: LlmProvider;
```

The model that JUDGES when live. Defaults to the agent's model.

##### llm?

```ts
readonly optional llm?: LlmProvider;
```

The model the AGENT was evaluated on, when the suite overrode it (its
`llm` option) — the live default for both of the above.

##### mode

```ts
readonly mode: EvalMode;
```

Which model this run got — the case context's `mode`. `"stub"` scripts the
caller and the judge too; a keyless simulation checks wiring, not behaviour.

##### providerEnv?

```ts
readonly optional providerEnv?: ProviderEnv;
```

Provider credentials when live. Defaults to `env` plus the host's own.

##### stubCaller?

```ts
readonly optional stubCaller?: StubScript;
```

The simulated caller's lines in a keyless run, one per caller turn. End it
with `{ tool: "end_call", args: { reason } }`; absent, the stub caller says
one line and hangs up.

##### stubJudge?

```ts
readonly optional stubJudge?: readonly boolean[];
```

The rulings a keyless judge hands back, one per criterion in order —
missing entries pass. Absent, every criterion passes, marked scripted.

##### target

```ts
readonly target: SimulationTarget;
```

What the simulated caller talks to — the case's `session`, or its text `agent`.

***

### JudgeCallOptions

```ts
type JudgeCallOptions = {
  context?: string;
  criteria: readonly string[];
  llm: LlmProvider;
  providerEnv?: ProviderEnv;
};
```

What [judgeCall](#judgecall) takes.

#### Properties

##### context?

```ts
readonly optional context?: string;
```

Extra context the judge should know — the agent's purpose, a policy.

##### criteria

```ts
readonly criteria: readonly string[];
```

What must be true of the conversation, one claim each — "the agent
confirmed the order number before cancelling". Phrase each so it can be
ruled on from the transcript alone.

##### llm

```ts
readonly llm: LlmProvider;
```

The JUDGING model. Any `@alexkroman1/aai/llm` descriptor.

##### providerEnv?

```ts
readonly optional providerEnv?: ProviderEnv;
```

Where the judge's credential is resolved from. Defaults to this machine's.

***

### JudgeInput

```ts
type JudgeInput = 
  | SimulatedCall
  | readonly EvalTurn[]
  | string;
```

What a judge may be handed: a simulated call, a list of turns, or a transcript.

***

### SimulateCallOptions

```ts
type SimulateCallOptions = {
  caller: SimulatedCaller;
  llm: LlmProvider;
  maxTurns?: number;
  providerEnv?: ProviderEnv;
};
```

What [simulateCall](#simulatecall) takes.

#### Properties

##### caller

```ts
readonly caller: SimulatedCaller;
```

Who is calling.

##### llm

```ts
readonly llm: LlmProvider;
```

The model PLAYING the caller. Any `@alexkroman1/aai/llm` descriptor —
including one from `installStubLlm`, which is how a keyless run scripts the
caller's lines (`{ tool: "end_call", args: { reason } }` ends it).

##### maxTurns?

```ts
readonly optional maxTurns?: number;
```

The most caller turns before the harness hangs up for them. Default
[DEFAULT\_MAX\_TURNS](#default_max_turns).

##### providerEnv?

```ts
readonly optional providerEnv?: ProviderEnv;
```

Where the caller model's credential is resolved from. Defaults to this
machine's environment, the same trust decision `openEvalSession` makes.

***

### SimulatedCall

```ts
type SimulatedCall = {
  caller: SimulatedCaller;
  endedBy: "caller" | "max-turns";
  endReason: string | undefined;
  greeting: readonly string[];
  metrics: SimulationMetrics;
  turns: readonly SimulatedTurn[];
  transcript: string;
};
```

A finished simulated call.

#### Methods

##### transcript()

```ts
transcript(): string;
```

The call as `Agent:`/`Caller:` lines — what a judge or a failure message reads.

###### Returns

`string`

#### Properties

##### caller

```ts
readonly caller: SimulatedCaller;
```

##### endedBy

```ts
readonly endedBy: "caller" | "max-turns";
```

`"caller"` — it called `end_call`. `"max-turns"` — the harness hung up
after [SimulateCallOptions.maxTurns](#maxturns), which usually means the goal
was never met.

##### endReason

```ts
readonly endReason: string | undefined;
```

The reason the caller gave to `end_call`, when it gave one.

##### greeting

```ts
readonly greeting: readonly string[];
```

The agent's opening line(s) before the caller spoke — empty for a text agent.

##### metrics

```ts
readonly metrics: SimulationMetrics;
```

##### turns

```ts
readonly turns: readonly SimulatedTurn[];
```

***

### SimulatedCaller

```ts
type SimulatedCaller = {
  goal: string;
  opening?: string;
  persona: string;
};
```

Who the simulated caller is, and what they called for.

#### Properties

##### goal

```ts
readonly goal: string;
```

What they want out of the call, stated as the CALLER would know it —
including the facts they hold ("order W1234", "a table for four on
Friday"). The simulating model is told to reveal them only when asked, as a
caller would.

##### opening?

```ts
readonly optional opening?: string;
```

The caller's first line. Absent, the model writes one — after the
greeting, when the target has one.

##### persona

```ts
readonly persona: string;
```

Who they are and how they talk — "a hurried commuter who answers in
fragments", "an elderly caller who asks for things to be repeated".

***

### SimulatedTurn

```ts
type SimulatedTurn = {
  caller: string;
  latencyMs: number | undefined;
  turn: EvalTurn;
};
```

One exchange: what the caller said and the turn it produced.

#### Properties

##### caller

```ts
readonly caller: string;
```

The caller's line.

##### latencyMs

```ts
readonly latencyMs: number | undefined;
```

Milliseconds from the committed utterance to the first reply text —
`undefined` for a turn that produced no text.

##### turn

```ts
readonly turn: EvalTurn;
```

The agent's turn in reply, exactly as `say()`/`send()` returned it.

***

### SimulationMetrics

```ts
type SimulationMetrics = {
  durationMs: number;
  latencyMs: {
     max: number | undefined;
     mean: number | undefined;
     p50: number | undefined;
  };
  toolCallCounts: Readonly<Record<string, number>>;
  toolCalls: readonly EvalToolCall[];
  turns: number;
};
```

What was measured over the whole call.

#### Properties

##### durationMs

```ts
readonly durationMs: number;
```

Wall-clock time of the whole simulation, caller model included.

##### latencyMs

```ts
readonly latencyMs: {
  max: number | undefined;
  mean: number | undefined;
  p50: number | undefined;
};
```

Reply latency over the turns that produced text.

###### max

```ts
readonly max: number | undefined;
```

###### mean

```ts
readonly mean: number | undefined;
```

###### p50

```ts
readonly p50: number | undefined;
```

##### toolCallCounts

```ts
readonly toolCallCounts: Readonly<Record<string, number>>;
```

Tool calls per tool name.

##### toolCalls

```ts
readonly toolCalls: readonly EvalToolCall[];
```

Every tool call the agent made, in order.

##### turns

```ts
readonly turns: number;
```

Caller turns taken.

***

### SimulationTarget

```ts
type SimulationTarget = 
  | {
  said: readonly string[];
  say: Promise<EvalTurn>;
}
  | {
  said: readonly string[];
  send: Promise<EvalTurn>;
};
```

What a simulation drives: an `EvalSession` (`say`) or an `EvalTextAgent`
(`send`). Structural, so either handle passes as is.

## Variables

### DEFAULT\_MAX\_TURNS

```ts
const DEFAULT_MAX_TURNS: 12 = 12;
```

How many caller turns a simulation may take unless told otherwise.

***

### END\_CALL\_TOOL

```ts
const END_CALL_TOOL: "end_call" = "end_call";
```

The name of the caller-side hang-up tool.
