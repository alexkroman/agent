# index

The AAI voice-agent SDK — the AUTHORING surface, and only that.

What an `agent.ts` imports: `agent()` and `tool()`, `sessionSlot()` and
`workflow()`, the types they take and return, the recommended
`assemblyAIPipeline()` preset, and the `assemblyAIS2s()` opt-in.

**The membership TEST is that an `agent.ts`, a tool module, or a
`workflow()` would NAME the symbol.** Two corollaries decide every case this
barrel has got wrong: a budget the framework enforces on its own does not
qualify however public it is, and neither does a value whose only use is
READING BACK what the framework already did — reproducing a default is what
`@alexkroman1/aai/internal` is for.

That test is why `sdk/constants.ts` is no longer re-exported here at all.
Eighteen `DEFAULT_*`/`MAX_*` constants were, on the argument that each one
documents an `agent()` field — but the field's own JSDoc already carries the
value (`@defaultValue \`10\``), so the constant answered nothing an author
could not read at the field, and none of the 25 templates, the scaffold, or
the shipped authoring guide named one. Their readers are a client sizing a
buffer, a harness matching the host's endpointing and a test asserting the
shipped value — framework code, which is the `/internal` audience exactly.
`MAX_DB_RESULT_ROWS` and `STORAGE_DISABLED_MESSAGE` went with them, which is
why `sdk/db.ts` is named rather than wildcarded below.

`DEFAULT_SYSTEM_PROMPT` is the one that stayed, and it stayed by PASSING the
test rather than as an exception: `agent({ systemPrompt })` replaces the
~10,000 characters of measured voice rules wholesale, so naming the constant
is the only way to keep them and add domain rules on top. That recipe is
documented on the constant and compiled by `check:doc-examples`; it reaches
this barrel through `./sdk/types.ts`.

Everything else the package publishes is on a subpath, chosen by WHO READS
IT:

| Subpath | Reach for it when |
| --- | --- |
| `@alexkroman1/aai/testing`, `/testing/vitest` | testing your own tools — `createToolContext`, `deployedAgent`, `runTool` |
| `@alexkroman1/aai/stt`, `/llm`, `/tts`, `/s2s` | picking a provider for a pipeline stage |
| `@alexkroman1/aai/step`, `/step-errors` | writing a step inside a workflow |
| `@alexkroman1/aai/workflow-api` | calling a deployed agent from a page, a script or a cron job |
| `@alexkroman1/aai/tools` | calling `fetchJson`/`webSearch`/`visitWebpage` from your own tool code |
| `@alexkroman1/aai/utils` | small helpers written inside a tool body |
| `@alexkroman1/aai/ffmpeg` | running ffmpeg from a step |
| `@alexkroman1/aai-runtime` | self-hosting the Node runtime |
| `@alexkroman1/aai/protocol`, `/manifest`, `/internal` | framework internals; not covered by semver |

Three primitives here run a defined process, and they are not
interchangeable. A `dialog()` gates a CONVERSATION — what the agent may say
or do next, across turns. A `procedure()` runs ONE UNIT OF WORK inside a
single tool call. A `workflow()` runs DURABLY, outliving the session.

## Functions

### agent()

```ts
function agent(def: AgentParams): AgentDef;
```

Define an agent: its system prompt, its providers, and its configuration.

Applies sensible defaults for omitted fields. Export as the default
export of your `agent.ts` file.

**Tools are not declared here** — a tool is a FILE. `tools/echo.ts` that
default-exports `tool({ … })` is the tool `echo`, registered by existing, and
`agent({ tools })` is a compile error naming the file to create
(`InlineToolsMisuse`).

#### Parameters

##### def

[`AgentParams`](#agentparams)

#### Returns

[`AgentDef`](#agentdef)

#### Examples

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Echo Agent",
  greeting: "Say something and I'll say it back.",
});
```

**Session state is not declared here either** — a [sessionSlot](#sessionslot-1) owns its
own default and its own storage, so there is no `state` factory to remember.
`syncState` takes that slot's projection.

**Default pipeline with a voice and a different LLM**

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  voice: "michael",
  llm: "claude-sonnet-4-6",
});
```

#### Remarks

Session mode: with no provider fields the agent runs the default
all-AssemblyAI cascaded pipeline. Set any subset of `stt`, `llm`, `tts`
to swap individual stages (unset stages keep the AssemblyAI default), and
`voice` to pick the default pipeline's TTS voice — or set `s2s` (e.g.
`assemblyAIS2s()`) to opt into the speech-to-speech path instead. See
[AgentDef](#agentdef) for every field.

***

### assemblyAIPipeline()

```ts
function assemblyAIPipeline(opts?: AssemblyAIPipelineOptions): {
  llm: LlmProvider;
  stt: SttProvider;
  tts: TtsProvider;
};
```

All three pipeline stages on AssemblyAI, ready to spread into `agent()`.

Every stage bills to `ASSEMBLYAI_API_KEY` — the one key a published agent is
guaranteed to have — so this configuration runs the moment it is deployed.

#### Parameters

##### opts?

[`AssemblyAIPipelineOptions`](#assemblyaipipelineoptions)

#### Returns

```ts
{
  llm: LlmProvider;
  stt: SttProvider;
  tts: TtsProvider;
}
```

##### llm

```ts
llm: LlmProvider;
```

##### stt

```ts
stt: SttProvider;
```

##### tts

```ts
tts: TtsProvider;
```

***

### assemblyAIS2s()

```ts
function assemblyAIS2s(opts?: AssemblyAIS2sOptions): S2sProvider;
```

Select AssemblyAI's speech-to-speech (Voice Agent API) session mode.
STT, the LLM loop, and TTS all run service-side over one socket.

#### Parameters

##### opts?

[`AssemblyAIS2sOptions`](#assemblyais2soptions)

#### Returns

[`S2sProvider`](#s2sprovider)

#### Example

```ts
import { agent, assemblyAIS2s } from "@alexkroman1/aai";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  s2s: assemblyAIS2s({ voice: "jane", languages: ["en"] }),
});
```

Setting `s2s` replaces the whole `stt`/`llm`/`tts` pipeline, and the
top-level `voice` convenience is a compile error alongside it — an S2S
voice rides on the descriptor, because the service synthesizes.

***

### createKeyedLock()

```ts
function createKeyedLock(): KeyedLock;
```

Create a [KeyedLock](#keyedlock).

Prefer [withLock](#withlock) at call sites — it releases in every outcome, which
a bare `lock()` leaves to the caller's `finally`.

#### Returns

[`KeyedLock`](#keyedlock)

***

### dialog()

#### Call Signature

```ts
function dialog<M extends AnyStateMachine>(
   key: string, 
   machine: M, 
   options?: DialogOptions
): Dialog<M>;
```

Declare a dialog statechart for an agent's conversation.

The machine is an ordinary XState machine, so everything XState knows how to
do with one applies — `@xstate/procedure` can enumerate its paths to generate
dialog test cases, and the machine is serializable for a visualizer.

##### Type Parameters

###### M

`M` *extends* `AnyStateMachine`

##### Parameters

###### key

`string`

The store key to occupy, like a [sessionSlot](#sessionslot-1)'s. Two flows
  must not share one, and a dialog must not share one with a slot.

###### machine

`M`

The machine. Give a state a `meta.instruction` and it becomes
  [DialogPosition.instruction](#instruction) while that state is active — which is what
  a refusal quotes and what every dialog tool's result carries.

###### options?

[`DialogOptions`](#dialogoptions)

##### Returns

[`Dialog`](#dialog)\<`M`\>

##### Examples

```ts
// shared.ts — the one place the dialog is declared.
import { dialog } from "@alexkroman1/aai";
import { setup } from "xstate";

const machine = setup({
  types: {} as { events: { type: "VERIFIED" } | { type: "QUOTED" } },
}).createMachine({
  id: "claim",
  initial: "verifying",
  states: {
    verifying: {
      meta: { instruction: "Get the caller's policy number and verify it." },
      on: { VERIFIED: "quoting" },
    },
    quoting: {
      meta: { instruction: "Read the excess disclosure, then quote." },
      on: { QUOTED: "done" },
    },
    done: { type: "final" },
  },
});

export const claim = dialog("claim", machine);
```

```ts no-check
// tools/quote_claim.ts — cannot run before the caller is verified.
// (`no-check`: the point of the example is the OTHER file's declaration.)
import { claim } from "../shared.ts";
import { z } from "zod";

export default claim.tool({
  description: "Quote the claim once the policy is verified",
  inputSchema: z.object({ excess: z.number() }),
  when: "quoting",
  send: { type: "QUOTED" },
  execute: ({ excess }) => ({ premium: excess * 2 }),
});
```

```ts
// The same dialog as a plain state map — no `setup()`, no events union to
// restate, no `meta` wrapper. `dialog.send` is typed from the `on` keys.
import { dialog } from "@alexkroman1/aai";

export const claim = dialog("claim", {
  initial: "verifying",
  states: {
    verifying: {
      instruction: "Get the caller's policy number and verify it.",
      on: { VERIFIED: "quoting" },
    },
    quoting: {
      instruction: "Read the excess disclosure, then quote.",
      on: { QUOTED: "done" },
    },
    done: { final: true },
  },
});
```

##### Remarks

**Three primitives here run a defined process; pick by SCOPE.** A
[dialog](#dialog-1) gates a CONVERSATION — what the agent may say or do next,
across turns, persisted in a session slot. A [procedure](#procedure-2) runs ONE UNIT
OF WORK inside a single tool call, never stored. A [workflow](#workflow-1) runs
DURABLY, outliving the session.

#### Call Signature

```ts
function dialog<S extends DialogSpec>(
   key: string, 
   spec: S, 
   options?: DialogOptions
): Dialog<AnyStateMachine, DialogEvent<S>>;
```

Declare a dialog from a plain state map — see [DialogSpec](#dialogspec).

The overload exists rather than replacing the machine form because the two
answer different questions. A spec covers what every dialog in the templates
actually used and nothing else, on purpose: a persisted snapshot must survive
`structuredClone`, so guards, context and actions were never available here
anyway, and what an author was paying for full XState was a `setup({ types:
{} as { events: … } })` block restating the event names already written in the
`on` maps. A dialog that needs more than the spec can say passes a machine,
and that path is unchanged.

It builds the same machine, so the STORED SNAPSHOT is byte-identical to the
hand-written equivalent's and a `durable: true` dialog resumes across the
switch — see `machineFromSpec`.

##### Type Parameters

###### S

`S` *extends* [`DialogSpec`](#dialogspec)

##### Parameters

###### key

`string`

###### spec

`S`

###### options?

[`DialogOptions`](#dialogoptions)

##### Returns

[`Dialog`](#dialog)\<`AnyStateMachine`, [`DialogEvent`](#dialogevent)\<`S`\>\>

***

### isRecord()

```ts
function isRecord(value: unknown): value is Record<string, unknown>;
```

Whether a value is a non-null, non-array object, narrowed to
`Record<string, unknown>` so its fields can be read without a second cast.

The narrowing is the point. `typeof value === "object" && value !== null` is
three tokens anyone can write, which is exactly why it was written twelve
times here — and it narrows to `object`, on which every field read is an
error, so each site paid for it again with a cast
(`(value as { kind?: unknown }).kind`). A cast is not a check: it says
nothing about the value and stops reporting when the shape moves.

Arrays are excluded because every caller is reading a NAMED field — `.type`,
`.error`, `.kind`, `.then` — none of which an array has. For "any non-null
object, arrays included", write the two comparisons inline; that case has one
site in this repo and does not want a name.

#### Parameters

##### value

`unknown`

#### Returns

`value is Record<string, unknown>`

#### Example

```ts
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";

function readStatus(body: string): string | undefined {
  const parsed = safeJsonParse(body);
  if (!isRecord(parsed)) return undefined;
  return typeof parsed.status === "string" ? parsed.status : undefined;
}
```

***

### omitUndefined()

```ts
function omitUndefined<T extends object>(obj: T): { [K in string | number | symbol]?: unknown extends T[K] ? NonNullable<unknown> | null : Exclude<T[K], undefined> };
```

Drop the `undefined`-valued entries of `obj`, typing every surviving key as
optional-and-defined — exactly what `exactOptionalPropertyTypes` wants on
the receiving end.

Spread the result into the literal it belongs to; the keys are the object's
own, so renaming one (`{ leadMs: audioLeadMs }`) works the same as passing
shorthand.

"Removed" means `undefined` and nothing else, so a `null` survives — a null
value is a value; only `undefined` is an absence here. The `unknown extends`
branch in the return type is written inline rather than named, so the one
new symbol on the published surface is this function; what it says is that
`Exclude<unknown, undefined>` is still `unknown`, which a field declared
`body?: unknown` (the CLI's API client has one) then cannot hand to anything
with a narrower parameter. `NonNullable<unknown> | null` is what "unknown,
but not undefined" means, and it is what the `!== undefined` narrowing this
replaces already produced. The check catches `any` too, which lands in the
same place.

#### Type Parameters

##### T

`T` *extends* `object`

#### Parameters

##### obj

`T`

#### Returns

\{ \[K in string \| number \| symbol\]?: unknown extends T\[K\] ? NonNullable\<unknown\> \| null : Exclude\<T\[K\], undefined\> \}

#### Example

```ts
import { omitUndefined } from "@alexkroman1/aai/utils";

declare const name: string | undefined;
declare const greeting: string | undefined;

const config: { slug: string; name?: string; greeting?: string } = {
  slug: "demo",
  ...omitUndefined({ name, greeting }),
};
```

***

### procedure()

```ts
function procedure<M extends AnyStateMachine>(machine: M): Procedure<M>;
```

Wrap a machine so a tool body can run it without touching an actor.

#### Type Parameters

##### M

`M` *extends* `AnyStateMachine`

#### Parameters

##### machine

`M`

An ordinary XState machine. Give it an `output` — that is
  what [Procedure.run](#run) resolves with, and a machine with none resolves
  `undefined`.

#### Returns

[`Procedure`](#procedure-1)\<`M`\>

#### Example

```ts
import { procedure, tool } from "@alexkroman1/aai";
import { setup } from "xstate";
import { z } from "zod";

const machine = setup({
  types: {} as { input: { topic: string }; output: { verdict: string } },
}).createMachine({
  id: "triage",
  initial: "deciding",
  context: ({ input }) => ({ topic: input.topic }),
  states: { deciding: { type: "final" } },
  output: ({ context }) => ({ verdict: `looked at ${context.topic}` }),
});

const triage = procedure(machine);

export default tool({
  description: "Triage a topic",
  inputSchema: z.object({ topic: z.string() }),
  // `ctx.signal` is what makes a barge-in stop the procedure mid-run.
  execute: async ({ topic }, ctx) => await triage.run({ topic }, { signal: ctx.signal }),
});
```

#### Remarks

**Three primitives here run a defined process; pick by SCOPE.** A
[dialog](#dialog-1) gates a CONVERSATION — what the agent may say or do next,
across turns, persisted in a session slot. A [procedure](#procedure-2) runs ONE UNIT
OF WORK inside a single tool call, never stored. A [workflow](#workflow-1) runs
DURABLY, outliving the session.

***

### requireEnv()

```ts
function requireEnv(ctx: {
  env: Readonly<Partial<Record<string, string>>>;
}, name: string): string;
```

Read a variable off [ToolContext.env](#env-1), failing by NAME when it is not set.

The `ToolContext` twin of `requireStepEnv`, and there for the same reason: a
missing credential is not transient, so it should say which key and how to
set it rather than surface as a `TypeError` on the first property access —
which `tool-executor.ts` serializes and hands to the MODEL, so what a caller
hears is the agent apologising for something no log line explains.

```ts no-check
export default tool({
  description: "Look up a note",
  inputSchema: z.object({ id: z.string() }),
  async execute({ id }, ctx) {
    const key = requireEnv(ctx, "NOTES_API_KEY");
    return await fetch(`https://notes.example.com/${id}`, {
      headers: { authorization: `Bearer ${key}` },
    }).then((r) => r.json());
  },
});
```

#### Parameters

##### ctx

###### env

`Readonly`\<`Partial`\<`Record`\<`string`, `string`\>\>\>

##### name

`string`

#### Returns

`string`

***

### resolveOne()

```ts
function resolveOne<T>(
   candidates: readonly T[], 
   spoken: string, 
   opts: ResolveOneOptions<T>
): ToolFailure | T;
```

Pick the one candidate an utterance names, or fail saying why.

The order is deliberate and is the part worth reusing:

1. **No candidates** — say so, rather than reporting a failed match against an
   empty list.
2. **A position** ("the second one", "the last one") — a caller who counts is
   unambiguous even when nothing else is, and this is the case a scorer alone
   cannot see.
3. **The scorer**, when one is given. A single best candidate wins; a tie
   fails, listing the tied ones only.
4. **Exactly one candidate left** — it is what they meant.
5. **Anything else is ambiguous**, and the failure lists the candidates.

The caller is expected to have narrowed first — by an id, by a status word,
by whatever its domain says an utterance can mean. This resolves what is
left.

#### Type Parameters

##### T

`T`

#### Parameters

##### candidates

readonly `T`[]

##### spoken

`string`

##### opts

[`ResolveOneOptions`](#resolveoneoptions)\<`T`\>

#### Returns

[`ToolFailure`](utils.md#toolfailure) \| `T`

#### Example

```ts
import { resolveOne } from "@alexkroman1/aai";

type Jacket = { id: string; color: string };
const jackets: Jacket[] = [
  { id: "1", color: "blue" },
  { id: "2", color: "red" },
];

const picked = resolveOne(jackets, "the blue one", {
  label: "jacket",
  describe: (jacket) => `${jacket.id} (${jacket.color})`,
  score: (jacket, text) => (text.includes(jacket.color) ? 1 : 0),
});
// → { id: "1", color: "blue" }
```

***

### safeJsonParse()

```ts
function safeJsonParse(text: string): unknown;
```

Parse JSON, returning `undefined` on malformed input. JSON cannot encode
`undefined`, so the sentinel is unambiguous.

#### Parameters

##### text

`string`

#### Returns

`unknown`

***

### sessionSlot()

```ts
function sessionSlot<K extends string, T, After = void>(
   key: K, 
   create: () => T, 
   options?: SessionSlotOptions<T, After>
): SessionSlot<K, T>;
```

Declare a named slot of per-session state.

An agent whose tools live in separate modules has no other way to type its
own state: a tool is a FILE, so there is no map to check it against the
agent's state shape, and there is no bag to annotate. A slot moves that
narrowing into ONE typed seam every module imports, and the lazy install with
it — plus, now, the storage. Nothing else stores session state.

[SessionSlot.tool](#tool-1) and [SessionSlot.updateTool](#updatetool) are the other
half: a tool declared through them is handed the value directly, so a tool
module needs neither an annotated context nor a `slot.get(ctx)` line.

#### Type Parameters

##### K

`K` *extends* `string`

##### T

`T`

##### After

`After` = `void`

#### Parameters

##### key

`K`

The store key to occupy. Two slots must not share one, and
  `claimKey` enforces it per session: two slots on one key that DISAGREE
  about the shape they store are refused the moment the second one is
  touched, since each would be reading and writing the other's value.

##### create

() => `T`

Factory for a fresh value. Called once per session on first
  access (and again on `reset`), so a shared module-level default must be
  cloned here — `() => structuredClone(DEFAULT)` — or every session mutates
  the same object.

##### options?

[`SessionSlotOptions`](#sessionslotoptions)\<`T`, `After`\>

#### Returns

[`SessionSlot`](#sessionslot)\<`K`, `T`\>

#### Examples

```ts
// shared.ts — the one place the slot is declared.
import { sessionSlot } from "@alexkroman1/aai";

export type Cart = { items: string[] };
export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [] }));
```

```ts no-check
// tools/add_item.ts — no cast, no annotation, no lazy-init boilerplate.
// (`no-check`: the point of the example is the OTHER file, so it cannot be
// self-contained.)
import { cartSlot } from "../shared.ts";
import { z } from "zod";

export default cartSlot.updateTool({
  description: "Add an item to the cart",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }, cart) => {
    cart.items.push(item);
    return { count: cart.items.length };
  },
});
```

***

### spokenDigits()

```ts
function spokenDigits(spoken: string): string;
```

The digits of a spoken number, with everything else dropped.

STT renders a read-aloud id every way a human says one — `"8642 1975"`,
`"8642-1975"`, `"864 219 75"` — and none of them equals the stored id. All of
them have the same digits in the same order.

#### Parameters

##### spoken

`string`

#### Returns

`string`

#### Example

```ts
import { spokenDigits } from "@alexkroman1/aai";

spokenDigits("that's 864-219-75"); // "86421975"
```

***

### spokenOrdinal()

```ts
function spokenOrdinal(spoken: string): number | undefined;
```

The position an utterance names, as an index, or `undefined` if it names none.

`-1` means the LAST candidate, following `Array.prototype.at` — which is also
how "the last one" has to be read, since it is a position from the other end.

Matched on word boundaries, so "firstly" and "the 21st" do not read as
positions — a substring test finds `first` in one and `1st` in the other, and
both would pick a candidate the caller never named.

What a boundary cannot rule out is a position word used as an ordinary noun:
"the first aid kit" really does contain the word "first". That is the reason
[resolveOne](#resolveone) takes a position only AFTER the caller has narrowed by
whatever its domain understands — an id, a status word — rather than before.

#### Parameters

##### spoken

`string`

#### Returns

`number` \| `undefined`

#### Example

```ts
import { spokenOrdinal } from "@alexkroman1/aai";

spokenOrdinal("cancel the second one"); // 1
spokenOrdinal("cancel the last one"); // -1
spokenOrdinal("cancel my order"); // undefined
```

***

### subagent()

```ts
function subagent(def: SubagentDef): SubagentDef;
```

Define a subagent.

An identity function, like [tool](#tool-2) — it exists for the type, for the
name to grep for, and so a subagent is declared at module scope rather than
rebuilt inside `execute` on every call.

#### Parameters

##### def

[`SubagentDef`](#subagentdef)

#### Returns

[`SubagentDef`](#subagentdef)

***

### tool()

```ts
function tool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(def: ToolDef<P, R>): ToolDef<P, R>;
```

Define a tool with a typed input schema and execute function.

Identity function for type inference — returns the input unchanged.
Follows the Vercel AI SDK `tool()` pattern (`inputSchema` names the same
field it does there). The schema is any Standard Schema that converts to
JSON Schema; Zod is the documented default.

#### Type Parameters

##### P

`P` *extends* [`ToolInputSchema`](#toolinputschema) = [`ToolInputSchema`](#toolinputschema)

##### R

`R` = `unknown`

#### Parameters

##### def

[`ToolDef`](#tooldef)\<`P`, `R`\>

#### Returns

[`ToolDef`](#tooldef)\<`P`, `R`\>

#### Examples

```ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

const greet = tool({
  description: "Greet someone by name",
  inputSchema: z.object({ name: z.string() }),
  execute: ({ name }) => `Hello, ${name}!`,
});
```

**Reading and writing session state**

```ts
import { sessionSlot, tool } from "@alexkroman1/aai";
import { z } from "zod";

const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));

const add = tool({
  description: "Add an item to the cart",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }, ctx) =>
    cartSlot.update(ctx, (cart) => {
      cart.items.push(item);
      return cart.items.length;
    }),
});
```

#### Remarks

It takes no state type parameter, and neither does [ToolContext](#toolcontext). A
tool reaches session state through a [sessionSlot](#sessionslot-1), which types the
value in the module that declares it — so a tool in its own file needs
neither an annotated context nor a cast.

***

### workflow()

#### Call Signature

```ts
function workflow<P extends ToolInputSchema = ToolInputSchema, O extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<unknown, unknown>>(def: Omit<WorkflowDef<P, InferSchemaOutput<O>>, "output"> & {
  output: O;
}): WorkflowDef<P, InferSchemaOutput<O>>;
```

Declare a durable workflow.

An identity function for type inference, exactly like `tool()` — the returned
object is the input unchanged. Workflows are named by the key they are declared
under, so this takes no `name`.

##### Type Parameters

###### P

`P` *extends* [`ToolInputSchema`](#toolinputschema) = [`ToolInputSchema`](#toolinputschema)

###### O

`O` *extends* `StandardSchemaV1`\<`unknown`, `unknown`\> = `StandardSchemaV1`\<`unknown`, `unknown`\>

##### Parameters

###### def

`Omit`\<[`WorkflowDef`](#workflowdef)\<`P`, [`InferSchemaOutput`](#inferschemaoutput)\<`O`\>\>, `"output"`\> & \{
  `output`: `O`;
\}

##### Returns

[`WorkflowDef`](#workflowdef)\<`P`, [`InferSchemaOutput`](#inferschemaoutput)\<`O`\>\>

##### Remarks

**Three primitives here run a defined process; pick by SCOPE.** A
[dialog](#dialog-1) gates a CONVERSATION — what the agent may say or do next,
across turns, persisted in a session slot. A [procedure](#procedure-2) runs ONE UNIT
OF WORK inside a single tool call, never stored. A [workflow](#workflow-1) runs
DURABLY, outliving the session.

It validates nothing at declaration time, and there is nothing left to
validate: a body is an ordinary function and a workflow's identity is the key
it is declared under, so the `workflowId` a compiler used to attach — and the
check that used to look for it — are both gone. See [WorkflowBody](workflow-api.md#workflowbody).

**Two signatures, and which one applies is decided by `output`.** With an
output schema the result type comes from the SCHEMA and the body is CHECKED
against it — a body returning something else is an error at the declaration,
naming the property that disagrees, rather than quietly redefining what the
workflow promises. With no `output` nothing changes: the result type is
inferred from the body exactly as before. Both answer the same
`WorkflowDef<P, R>`, so nothing downstream can tell which was used.

##### Examples

`agent.ts` — declare the workflow beside the agent. A tool is a FILE, so
`agent()` takes no `tools`. Declaring `output` beside `input` is what makes
the run's result checked where it completes and typed where it is read.
```ts no-check
import { agent, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { digestFlow } from "./workflows/digest.ts";

export const digest = workflow({
  description: "Research a topic overnight and store the result",
  input: z.object({ topic: z.string() }),
  output: z.object({ topic: z.string(), headline: z.string() }),
  run: digestFlow,
});

export default agent({
  name: "Researcher",
  workflows: { digest },
});
```

`tools/research.ts` — the tool that starts a run.
```ts no-check
import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { digest } from "../agent.ts";

export default tool({
  description: "Kick off overnight research on a topic",
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }, ctx) => {
    // The workflow itself, not its name: typed input, and a typo is a
    // compile error. `key` is what lets a later turn find this run.
    const runId = await ctx.workflows.start(digest, { topic }, { key: ctx.sessionId });
    return `Working on it — run ${runId}.`;
  },
});
```

#### Call Signature

```ts
function workflow<P extends ToolInputSchema = ToolInputSchema, R = unknown>(def: WorkflowDef<P, R>): WorkflowDef<P, R>;
```

Declare a durable workflow.

An identity function for type inference, exactly like `tool()` — the returned
object is the input unchanged. Workflows are named by the key they are declared
under, so this takes no `name`.

##### Type Parameters

###### P

`P` *extends* [`ToolInputSchema`](#toolinputschema) = [`ToolInputSchema`](#toolinputschema)

###### R

`R` = `unknown`

##### Parameters

###### def

[`WorkflowDef`](#workflowdef)\<`P`, `R`\>

##### Returns

[`WorkflowDef`](#workflowdef)\<`P`, `R`\>

##### Remarks

**Three primitives here run a defined process; pick by SCOPE.** A
[dialog](#dialog-1) gates a CONVERSATION — what the agent may say or do next,
across turns, persisted in a session slot. A [procedure](#procedure-2) runs ONE UNIT
OF WORK inside a single tool call, never stored. A [workflow](#workflow-1) runs
DURABLY, outliving the session.

It validates nothing at declaration time, and there is nothing left to
validate: a body is an ordinary function and a workflow's identity is the key
it is declared under, so the `workflowId` a compiler used to attach — and the
check that used to look for it — are both gone. See [WorkflowBody](workflow-api.md#workflowbody).

**Two signatures, and which one applies is decided by `output`.** With an
output schema the result type comes from the SCHEMA and the body is CHECKED
against it — a body returning something else is an error at the declaration,
naming the property that disagrees, rather than quietly redefining what the
workflow promises. With no `output` nothing changes: the result type is
inferred from the body exactly as before. Both answer the same
`WorkflowDef<P, R>`, so nothing downstream can tell which was used.

##### Examples

`agent.ts` — declare the workflow beside the agent. A tool is a FILE, so
`agent()` takes no `tools`. Declaring `output` beside `input` is what makes
the run's result checked where it completes and typed where it is read.
```ts no-check
import { agent, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { digestFlow } from "./workflows/digest.ts";

export const digest = workflow({
  description: "Research a topic overnight and store the result",
  input: z.object({ topic: z.string() }),
  output: z.object({ topic: z.string(), headline: z.string() }),
  run: digestFlow,
});

export default agent({
  name: "Researcher",
  workflows: { digest },
});
```

`tools/research.ts` — the tool that starts a run.
```ts no-check
import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { digest } from "../agent.ts";

export default tool({
  description: "Kick off overnight research on a topic",
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }, ctx) => {
    // The workflow itself, not its name: typed input, and a typo is a
    // compile error. `key` is what lets a later turn find this run.
    const runId = await ctx.workflows.start(digest, { topic }, { key: ctx.sessionId });
    return `Working on it — run ${runId}.`;
  },
});
```

***

### workflowApp()

```ts
function workflowApp(def: Omit<StaticAgentParams, "page">): AgentDef;
```

Define a WORKFLOW APP — an agent whose front door is a form rather than a
microphone, and whose work happens in `workflows`.

`agent({ …, page: "static" })` with the discriminant already set, so the
mode is the CALL rather than a field to remember, and the fields a workflow
app has no use for are absent from the parameter type instead of being
rejected by it. Returns the same [AgentDef](#agentdef) `agent()` does — there is
one definition type, one config, one deploy path, and `page` is only ever
about the front door.

It mirrors the split `@alexkroman1/aai-ui` already makes in the browser:
`page()` mounts a workflow app's UI and `client()` mounts a voice one,
because a flag would leave every session-shaped question ("what does this
mean with no session?") answered by a conditional. Same reasoning, same
seam, other end of the wire.

#### Parameters

##### def

`Omit`\<[`StaticAgentParams`](#staticagentparams), `"page"`\>

#### Returns

[`AgentDef`](#agentdef)

#### Example

```ts
import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";

export const digest = workflow({
  description: "Summarize a link",
  input: z.object({ url: z.url() }),
  run: async ({ url }) => ({ url }),
});

export default workflowApp({
  name: "Link Digest",
  workflows: { digest },
});
```

## Classes

### KeyedLockTimeoutError

Thrown when an acquire deadline lapses before the key came free.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new KeyedLockTimeoutError(
   key: string, 
   timeoutMs: number, 
   options?: ErrorOptions
): KeyedLockTimeoutError;
```

###### Parameters

###### key

`string`

###### timeoutMs

`number`

###### options?

`ErrorOptions`

###### Returns

[`KeyedLockTimeoutError`](#keyedlocktimeouterror)

###### Overrides

```ts
Error.constructor
```

#### Properties

##### key

```ts
readonly key: string;
```

***

### ProcedureNotFinishedError

The error a run that did not finish rejects with.

Its own class because the two ways to not finish — aborted by a caller, or
stopped for any other reason — are the same fact to a tool body (there is no
output) and different facts to a log.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new ProcedureNotFinishedError(procedure: string, aborted: boolean): ProcedureNotFinishedError;
```

###### Parameters

###### procedure

`string`

###### aborted

`boolean`

###### Returns

[`ProcedureNotFinishedError`](#procedurenotfinishederror)

###### Overrides

```ts
Error.constructor
```

#### Properties

##### aborted

```ts
readonly aborted: boolean;
```

Whether the run's `signal` is what ended it.

##### procedure

```ts
readonly procedure: string;
```

The machine's id, so a log names which procedure stopped.

## Interfaces

### AgentDef

Fully resolved agent definition.

**This is what `agent()` RETURNS, not what you write.** You write
[AgentParams](#agentparams) — the same fields with the defaulted ones optional, plus the
conveniences `agent()` normalizes away (`system`, `llm` as a model-id string,
`voice`, `minTurnSilenceMs`/`maxTurnSilenceMs`). This is the reference for what
a field MEANS; `AgentParams` is the one for which combinations are legal.

Core fields (`name`, `systemPrompt`, `greeting`, `maxSteps`, `tools`)
are resolved to their final values with defaults applied. Optional fields
(`sttPrompt`, the tuning knobs, the provider descriptors, etc.) remain
optional — `undefined` means "not configured."

The pipeline-only voice-UX knobs live on [PipelineVoiceTuning](#pipelinevoicetuning), which
this extends: they share one rule (pipeline transport or nothing), and
both `agent()` and the deploy-time config check derive their field lists from
that interface, so a new one cannot skip either gate.

#### Extends

- [`PipelineVoiceTuning`](#pipelinevoicetuning)

#### Properties

##### builtinTools?

```ts
optional builtinTools?: readonly BuiltinTool[];
```

Built-in server-side tools enabled for this agent. Unset enables NONE
(`DEFAULT_BUILTIN_TOOLS` is empty) — a built-in is something an agent
asks for rather than something it has to notice and switch off, so `[]` and
omitting the field mean the same thing. See [BuiltinTool](#builtintool) for the
catalog.

###### Default Value

`[]` (`DEFAULT_BUILTIN_TOOLS`)

##### deadAirCoverMs?

```ts
optional deadAirCoverMs?: number;
```

Pipeline mode only. How long a turn may send nothing to the caller before
the transport speaks a short filler, so a long tool chain doesn't sound
like a dropped call. MEASURED silence, so a prompt reply pays nothing; `0`
disables. The wording is internal and must stay purely declarative — see
`DEAD_AIR_COVER_PHRASES` for why.

###### Default Value

`5000` (`DEFAULT_DEAD_AIR_COVER_MS`)

###### Inherited from

[`PipelineVoiceTuning`](#pipelinevoicetuning).[`deadAirCoverMs`](#deadaircoverms-1)

##### errorPhrase?

```ts
optional errorPhrase?: string;
```

Pipeline mode only. Phrase spoken when the turn's LLM stream fails, so a
provider outage hands the conversation back instead of going silent — a
failed turn produces no text, so nothing would otherwise reach TTS. Set
`""` to disable.

###### Default Value

`"Sorry, I had a problem just then. Could you say that
again?"` (`DEFAULT_ERROR_PHRASE`)

###### Inherited from

[`PipelineVoiceTuning`](#pipelinevoicetuning).[`errorPhrase`](#errorphrase-1)

##### events?

```ts
optional events?: SessionEventHandlers;
```

Observe the session's own event stream — an audit log, per-turn metrics, or
"write every call to my own database".

Keyed by event type, with `"*"` matching every event. Typed handlers run
first, then `"*"`, and both run AFTER the event has been recorded in the
session's retained stream and sent to the client:

```ts
import { agent } from "@alexkroman1/aai";

agent({
  name: "Audited",
  events: {
    "tool.called": (e, ctx) => {
      // A hook gets `ctx.env` and `ctx.slots`, never a database — persist
      // through a client of your own if you need to.
      void fetch(`${ctx.env.AUDIT_URL}`, {
        method: "POST",
        body: JSON.stringify({ id: e.meta.id, tool: e.toolName }),
      });
    },
    "*": (e) => console.log(e.meta.at, e.type),
  },
});
```

Three properties are load-bearing, and each is a rule rather than a detail:

- **Observe-only.** A handler cannot inject model context, change a reply, or
  cancel anything. That is what keeps the stream a LOG rather than a second
  control path, and it is why a handler receives no way to reply.
- **A throw is NON-FATAL.** It is logged against the event and the session
  continues — a failing audit hook must not end a phone call. An async
  handler is not awaited either, for the same reason: the caller is mid-turn.
- **Delivery is at-least-once, and `meta.id` is the key.** The id is stable
  across replays, so a handler storing content keys on it; a handler doing a
  non-idempotent side effect keys on the work's own coordinates instead,
  because retried work re-emits under fresh ids.

Before this there was no way for an agent author to observe their own agent
at all: the framework carried 51 internal `on*` callback options and not one
of them was reachable from `agent.ts`.

##### greeting

```ts
greeting: string;
```

Sentence spoken when a session starts. Set `""` to start silent.

###### Default Value

`"Hey there! I'm an AI voice assistant. What can I help you
with?"` (`DEFAULT_GREETING`)

##### idleTimeoutMs?

```ts
optional idleTimeoutMs?: number;
```

How long the session may go with no inbound audio before it is closed
(ms). Measures silence, not call length — re-armed on every audio frame.
`0` or a non-finite value disables the timer entirely.

###### Default Value

`300_000` (5 minutes, `DEFAULT_IDLE_TIMEOUT_MS`)

##### interruptionMinDurationMs?

```ts
optional interruptionMinDurationMs?: number;
```

Pipeline mode only. Minimum sustained speech (ms since the utterance's
first interim transcript) before an interim-triggered barge-in aborts the
agent's reply — a duration gate alongside `minBargeInWords`, mirroring
LiveKit's `min_interruption_duration`. Committed turns (STT finals) are
never gated. Set 0 to disable the gate.

###### Default Value

`500` (`DEFAULT_INTERRUPTION_MIN_DURATION_MS`)

###### Inherited from

[`PipelineVoiceTuning`](#pipelinevoicetuning).[`interruptionMinDurationMs`](#interruptionmindurationms-1)

##### llm?

```ts
optional llm?: LlmProvider;
```

Pluggable LLM provider descriptor from `@alexkroman1/aai/llm` (e.g.
`anthropicLlm({ model })`) for pipeline mode. Unset (with no `s2s`), the
stage defaults to the AssemblyAI LLM Gateway. Note this is pure
serializable data, not a Vercel AI SDK `LanguageModel` instance — the
host resolves the descriptor into a `LanguageModel` at session start,
using credentials from the agent's env.

##### maxSteps

```ts
maxSteps: number;
```

Max TOOL-CALLING steps per reply — bounds runaway tool loops. On reaching
the cap the pipeline spends one more step with `toolChoice: "none"`, so a
capped turn still answers rather than stopping mid-chain in silence.

###### Default Value

`10` (`DEFAULT_MAX_STEPS`)

##### minBargeInWords?

```ts
optional minBargeInWords?: number;
```

Pipeline mode only. Minimum words in an interim transcript before user
speech barges in on (aborts) the agent's in-flight reply. Set 1 to
interrupt on any word.

###### Default Value

`2` (`DEFAULT_MIN_BARGE_IN_WORDS`) — so one-word
backchannels ("yeah", "mm-hmm") don't cut the agent off.

###### Inherited from

[`PipelineVoiceTuning`](#pipelinevoicetuning).[`minBargeInWords`](#minbargeinwords-1)

##### name

```ts
name: string;
```

Display name shown by the default client UI.

##### page?

```ts
optional page?: "voice" | "static";
```

What this agent's front door IS — and so whether it serves voice at all.

###### Default Value

`"voice"`

`"static"` declares a WORKFLOW APP: an ordinary web page over the workflow
HTTP API (`/workflows/*`), with no microphone, no WebSocket and no session.
The page is still a `client.tsx`, still React, still Tailwind — it just
mounts with `page()` instead of `client()` and reaches the agent through
`createWorkflowApi()` / `useWorkflowRun()` instead of `useSession()`.

Declaring it is not decoration. `createServer` refuses the voice surfaces
for a static agent, so a page that has no session cannot be handed a socket
that would never answer, and telephony defaults off for one — an agent with
no `stt`/`llm`/`tts` has nothing to put on a phone call.

The two are not exclusive at the FEATURE level: a `"voice"` agent may
declare workflows and start them from a tool, and a `"static"` one may
declare tools it never reaches. This field is only about the surface.

##### preemptiveGeneration?

```ts
optional preemptiveGeneration?: boolean;
```

Pipeline mode only. Start generating the reply from a high-confidence
INTERIM transcript, and adopt that already-running stream when the
committed final turns out to say the same thing.

###### Default Value

`false` — measured on a tool-calling agent and not worth its
cost there. Set `true` where the arithmetic plausibly differs: a text-heavy
agent, or a longer head start from later endpointing.

###### Remarks

**Why it is off.** A `headStartMs`/adoption-rate log over a tau2-bench
retail run: 16 speculations started, 14 adopted at a p50 0.44s head start,
and 5 of those 14 (36%) poisoned after adoption by a tool call — unusable
whole, so the generation is discarded and the request reissued, each having
burned p50 0.69s first. Net +8ms per caller turn against a p50 first word of
~1.0s, for 44% of its LLM requests thrown away.

The head start does not survive contact with time-to-first-token: 0.44s
against a p50 of 1.10s, so at adoption the speculation has generated
nothing and whether its first part will be text or a tool call cannot be
known then. A gate on "has it produced text" was tried and reverted — it
rejects essentially every adoption, keeping the wasted request and losing
the benefit.

Its reach is bounded independently of that: across 815 replies in two
tau2-bench retail runs, 28-33% of replies called a tool at all (the
distribution recorded on `DEFAULT_MAX_STEPS`), so at most the
remaining 67-72% can ever be accelerated.

**What it structurally cannot do**, by construction rather than by flag:
a speculation never reaches TTS, never
emits a client frame, never writes either history view, and never EXECUTES
a tool — its tool set is declaration-only, so the model cannot continue past
a tool call, and a speculation that reaches one is discarded whole. Adoption
requires the final to match the speculated text after normalization
(case/punctuation only); an extension, a truncation or a revision all
discard and the turn runs exactly as it does with the flag off. At most 2
speculations per utterance. So the worst case is one extra billed LLM
request for that utterance.

Turning it back on by default is owed a tau2-bench run at the same tasks
and seed showing no reward regression.

###### Inherited from

[`PipelineVoiceTuning`](#pipelinevoicetuning).[`preemptiveGeneration`](#preemptivegeneration-1)

##### requiredEnv?

```ts
optional requiredEnv?: readonly string[];
```

Env var names this agent's code reads (beyond provider credentials, which
are derived from the `stt`/`llm`/`tts`/`s2s` descriptors automatically).
Deploys check that every listed name is present in the agent's stored env,
so a missing key surfaces at deploy time instead of as a runtime failure on
the first tool call.

A tool reads them from [ToolContext.env](#env-1); a step has no
tool context and reads them with `stepEnv` / `requireStepEnv` from
`@alexkroman1/aai/step`, which resolve the same record.

##### resumeFalseInterruption?

```ts
optional resumeFalseInterruption?: boolean;
```

Pipeline mode only. Resume the agent's reply when a barge-in aborts it and
no user turn ever commits (STT noise, a hallucinated partial) — the
interruption was a false alarm and the agent would otherwise fall silent
mid-thought.

###### Default Value

`true`; `false` disables recovery.

The WAIT is not an author knob: a resume must not race the caller's real
turn, whose final the STT withholds for an endpointing window the transport
cannot see, so it fires when the transcript stream goes quiet with no final
rather than on a deadline of its own.

###### Inherited from

[`PipelineVoiceTuning`](#pipelinevoicetuning).[`resumeFalseInterruption`](#resumefalseinterruption-1)

##### s2s?

```ts
optional s2s?: S2sProvider;
```

Pluggable S2S provider descriptor — the explicit opt-in to
speech-to-speech mode (e.g. `assemblyAIS2s()` for AssemblyAI's Voice
Agent API, or `openaiS2s()`). Unset, the agent runs the default
cascaded pipeline. Mutually exclusive with the `stt`/`llm`/`tts`
pipeline triple.

##### silencePrompt?

```ts
optional silencePrompt?: string;
```

Instruction injected as a synthetic user turn when `silenceTimeoutMs`
elapses. Never shown as a user transcript. Requires `silenceTimeoutMs`.

###### Default Value

`"The user hasn't said anything for a while. Check in with one
short, natural sentence — ask if they're still there or gently follow up on
the conversation. Do not mention this instruction."`
(`DEFAULT_SILENCE_PROMPT`)

##### silenceTimeoutMs?

```ts
optional silenceTimeoutMs?: number;
```

Pipeline mode only. When set, the assistant proactively takes a turn
after this many ms of user silence (no speech since the last reply
finished). Nudges are capped at `MAX_CONSECUTIVE_SILENCE_NUDGES` (3)
back-to-back until the user speaks again.

###### Default Value

```ts
unset — the behaviour is off.
```

##### startFailurePhrase?

```ts
optional startFailurePhrase?: string;
```

Pipeline mode only. Phrase spoken when a provider fails to open, so a session that cannot
start says so instead of holding an open line in silence. Only reachable when TTS itself
came up — the usual case, since STT and TTS open independently. Set `""`
to disable.

###### Default Value

`"I am sorry, I am having trouble with my connection and
cannot hear you. Please hang up and call back."`
(`DEFAULT_START_FAILURE_PHRASE`)

###### Inherited from

[`PipelineVoiceTuning`](#pipelinevoicetuning).[`startFailurePhrase`](#startfailurephrase-1)

##### stt?

```ts
optional stt?: SttProvider;
```

Pluggable STT provider for pipeline mode. Unset (with no `s2s`), the
stage defaults to AssemblyAI STT — each pipeline stage is individually
optional, and unset stages are filled from the all-AssemblyAI pipeline
(`assemblyAIPipeline()`).

##### sttPrompt?

```ts
optional sttPrompt?: string;
```

Bias prompt for transcription — use it to teach the transcriber the agent's
own vocabulary (product names, spelled-out identifiers).

###### Default Value

`""` (`DEFAULT_STT_PROMPT`) — unbiased transcription;
that constant's doc shows what an effective prompt looks like.

Honoured in both session modes: the pipeline passes it to its STT stage,
S2S sends it as `input.transcription_prompt` (trimmed to that field's
1750-char cap). It was pipeline-only until measurement showed what it costs
to drop — on tau2-bench retail a transcription prompt took the caller's
spelled first name from 1 of 6 attempts correct to 6 of 6, and the S2S path
was ignoring the field without a warning.

##### syncState?

```ts
optional syncState?: 
  | StateProjection<unknown>
  | readonly StateProjection<unknown>[];
```

Project per-session state to the browser client, so a custom UI can
render it without the agent hand-rolling a sync channel.

One [SessionSlot.projection](#projection-1) per slot the client should see, or an
array of them — the `agent_state` frame carries the merge. A slot the agent
does not project never leaves the server, which is the point: session state
routinely holds things a browser should not have, so the author decides what
leaves, and whatever a projection returns is exactly what `useAgentState`
receives.

Pushed after every tool call, and only when a projection actually changed —
most turns do not touch state, and this shares a socket with 384 kbps of
PCM.

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";
type Item = { sku: string; qty: number };

const cartSlot = sessionSlot("cart", () => ({ items: [] as Item[], staffPin: "" }));

agent({
  name: "Cart",
  // staffPin stays server-side
  syncState: cartSlot.projection((s) => ({ items: s.items })),
});
```

###### Remarks

It took a `(state: S) => unknown` over the whole state bag until the bag was
removed. A projection now names its own slot, which is what lets the runtime
render a session that has run no tool yet — the projection carries the
slot's default — and so what let `AgentDef.state` be deleted rather than
remembered.

Without any of this, the pattern agents reach for is: return a state
snapshot from every tool, declare a result type describing it, and mirror it
into `useState` via `useToolResult`. Measured across generated agents, 58%
built some version of that by hand.

##### systemPrompt

```ts
systemPrompt: string;
```

System prompt driving the LLM.

###### Default Value

[DEFAULT\_SYSTEM\_PROMPT](#default_system_prompt) — the framework's own voice-agent
prompt. It is assembled from parts, so it is the one default here whose
VALUE cannot usefully be inlined; read the constant.

##### temperature?

```ts
optional temperature?: number;
```

Sampling temperature for the agent's OWN model calls — the conversational
loop, in pipeline and text modes.

Omitted by default, so the model's own default applies; some models (Claude
5 among them) ignore it and warn, so set it only for a temperature-capable
one. A booking desk and a game master want different values, and until this
existed neither could say so: `ctx.generate` and `subagent()` both took a
temperature while the main loop — the one that does almost all the talking
— took no sampling parameter at all.

S2S REJECTS it rather than ignoring it (`assertSamplingScope`): there the
model runs inside the provider's service and this runtime never sees the
request.

##### text?

```ts
optional text?: true;
```

Opt into TEXT mode — an agent with no audio path at all, driven over a
message list by `createTextAgent` (`@alexkroman1/aai-runtime`) instead of
by a transport over a session socket.

A text agent is the same `agent()` definition every voice agent is —
`systemPrompt`, `tools`, `maxSteps`, `toolChoice`, `builtinTools`,
`requiredEnv` and a tool's `sessionSlot`s all mean exactly what they mean
elsewhere, and
tools run through the same executor, so one tool works in both. What it
drops is everything downstream of speech: `stt`, `tts` and `s2s` are
rejected (there is no audio to transcribe or synthesize), as are the
voice-UX tuning knobs and the silence nudge. `llm` is the one stage it
has, and it defaults to the AssemblyAI LLM Gateway like every other.

Explicit, never derived — the same rule `s2s` follows. A mode reachable
by omission is one a config lands in when it loses a field, and the
symptom there would be a deployed voice agent that answers nothing.

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Docs Assistant",
  text: true,
  systemPrompt: "Answer questions about the docs.",
});
```

Its tools are files under `tools/`, exactly as a voice agent's are.

##### toolChoice?

```ts
optional toolChoice?: ToolChoice;
```

How the LLM selects tools each step.

###### Default Value

`"auto"` (`DEFAULT_TOOL_CHOICE`) — the model decides.

Honored in pipeline mode and by the OpenAI Realtime transport; the
AssemblyAI S2S service runs the tool loop service-side and does not
take a tool-choice parameter.

##### tools

```ts
tools: Readonly<Record<string, ToolDef<ToolInputSchema>>>;
```

The tools the agent may invoke, keyed by the name the model calls.

**Not authored — RESOLVED.** `agent()` returns this empty and rejects a
`tools` argument outright (`InlineToolsMisuse`); the table is filled by
`withTools`, over a registry built from a `tools/` directory. The build is
what enumerates that directory — a deployed agent is handed one ESM string
and has no filesystem to scan — and a spec imports the same lowering
ready-made: `import agentDef from "virtual:aai/agent"` under vitest, or
`deployedAgent(def, { tools, systemPrompt })` from
`@alexkroman1/aai/testing` under any other runner.
So a tool's name is its FILE name and nothing else records it.

###### Remarks

This record carries no state type, and there is none to carry: a tool reads
and writes session state through [sessionSlot](#sessionslot-1), which types the value
in the module that declares the slot. The `NoInfer<S>` this used to hold
existed to keep a single un-annotated tool from dragging the agent's whole
state shape back to `unknown`, which is a problem a slot does not have.

##### tts?

```ts
optional tts?: TtsProvider;
```

Pluggable TTS provider for pipeline mode. Unset (with no `s2s`), the
stage defaults to AssemblyAI TTS (`agent()`'s `voice` shorthand picks
its voice).

##### workflows?

```ts
optional workflows?: Readonly<Record<string, WorkflowDef>>;
```

Durable workflows this agent may start, keyed by workflow name.

###### Remarks

The key is the NAME — nothing else records it, which is what makes a rename
a one-place change and what `ctx.workflows.start(def, …)` resolves a
definition against by identity.

Host-only, like `tools`, because a definition holds a function. The platform
therefore never reads this record: a page's `GET /workflows` listing is
served by the GUEST from its own live agent definition, the same way
`name`/`greeting` are proxied rather than read from the stored config.

***

### AssemblyAIPipelineOptions

#### Properties

##### maxTurnSilenceMs?

```ts
optional maxTurnSilenceMs?: number;
```

See [AssemblyAIPipelineOptions.minTurnSilenceMs](#minturnsilencems).

##### minTurnSilenceMs?

```ts
optional minTurnSilenceMs?: number;
```

End-of-turn window for the STT stage, in ms — the same two settings
`agent({ minTurnSilenceMs, maxTurnSilenceMs })` reaches without the
preset, here for a config that already spreads it (an EU region, say).

`maxTurnSilenceMs` is the PAUSE-TOLERANCE knob: it bounds only utterances
that never read as complete, so raising it is paid for by hesitant speech
alone. `minTurnSilenceMs` is the end-of-turn CHECK and taxes every
finished utterance. Read `DEFAULT_MAX_TURN_SILENCE_MS` and
`DEFAULT_MIN_TURN_SILENCE_MS` before moving either — both are measured.

##### region?

```ts
optional region?: "us" | "eu";
```

EU data residency. Applies to STT and the LLM gateway; TTS has a single
endpoint. Note the EU gateway serves only Claude and most Gemini models,
so an EU agent must also override `llm` with a model the EU endpoint
carries (e.g. `llm: "claude-sonnet-4-6"` after the spread). An override
that replaces a whole stage descriptor must re-declare `region` itself —
`stt: assemblyAIStt({ model, region: "eu" })` — since it replaces the
preset's descriptor including its region.

##### voice?

```ts
optional voice?: AssemblyAITtsVoice;
```

TTS voice id, e.g. `"jane"`, `"michael"`, `"alba"`. Defaults to
`"jane"` (US-accented English). Each voice speaks exactly one
language — see
`ASSEMBLYAI_TTS_VOICES` (from `@alexkroman1/aai/tts`) for the
catalog; a name outside it fails in-band after connect and leaves the
agent silent. (`agent({ voice })` is the same setting without the
preset.)

***

### AssemblyAIS2sOptions

Options for [assemblyAIS2s](#assemblyais2s).

The descriptor took NO options until 2026-08-09, which left every
author-controlled knob on the S2S session unreachable while the pipeline had
all of them. That asymmetry had a measured cost: on tau2-bench retail,
pinning `language_codes: ["en"]` alongside voice focus and a transcription
prompt took the authenticating caller's spelled first name from 1 of 6
attempts correct to 6 of 6, and word recall from ~0.89 to ~0.93. The other
two of those three are pinned host-side; the language pin is the one that
MUST stay author-controlled (see [AssemblyAIS2sOptions.languages](#languages)), so
without a field here it could not be set at all.

Deliberately absent: `turn_detection`. Its service default is adaptive and
entity-aware — it waits out a spelled-out value — and setting
`min_silence`/`max_silence` disables both for the rest of the session.

#### Extends

- [`ProviderCredentialOptions`](#providercredentialoptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ProviderCredentialOptions`](#providercredentialoptions).[`apiKeyEnv`](#apikeyenv-1)

##### keyterms?

```ts
optional keyterms?: readonly string[];
```

Domain terms to bias transcription toward (`input.keyterms`) — product
names, proper nouns, spelled identifiers the model would otherwise
mis-hear. Complements `sttPrompt`, which is prose rather than a term list.

##### languages?

```ts
optional languages?: readonly string[];
```

Language codes to bias transcription toward (`input.language_codes`).

Leave UNSET to detect per turn — that is a real setting, not an absent
one, and a host-side `["en"]` default would silently disable multilingual
transcription for every agent (the mirror-image bug of the one this field
fixes). Pin one code for a monolingual line; a multi-element list biases
toward a known subset while keeping code-switching.

##### voice?

```ts
optional voice?: string;
```

Voice for the agent's synthesized speech (`output.voice`). Unset uses the
service default.

The accepted set is the service's, and is NOT verified in this repo — the
failure mode is the one `ASSEMBLYAI_TTS_VOICES` (from
`@alexkroman1/aai/tts`) exists to prevent, so treat an id from outside that
catalog as unproven: a voice the service rejects comes back in-band after
the socket opens, leaving an agent that connects, reports ready, and never
speaks.

***

### DelegateOptions

Per-call options for [DelegateFn](#delegatefn).

#### Properties

##### context?

```ts
optional context?: string;
```

Extra context appended after the subagent's own `systemPrompt` for this
call — the caller's name, what has already been ruled out, the format the
answer should take. Absent by default, because a subagent that needs the
conversation to make sense is one whose task was underspecified.

##### maxSteps?

```ts
optional maxSteps?: number;
```

Override the subagent's step budget for this call.

##### task

```ts
task: string;
```

The task, as the subagent's first user message. Write it as a complete
brief: the subagent's context is ISOLATED, so it has not read the
conversation and knows nothing the task does not say.

***

### DelegateResult

What one delegated run returns.

`text` is the answer; `steps` and `toolCalls` are what the run COST, which
is the half a voice agent needs in order to say something true about the
wait ("I checked four sources"). They are a report, not a transcript: the
tool RESULTS stay inside the subagent's context, which is the entire reason
to have delegated.

#### Properties

##### steps

```ts
steps: number;
```

How many steps the run took, including the final answering step.

##### text

```ts
text: string;
```

The subagent's final message — see [SubagentDef.systemPrompt](#systemprompt-1).

##### toolCalls

```ts
toolCalls: readonly SubagentToolCall[];
```

Every tool call the subagent made, in order.

***

### Dialog

A dialog statechart bound to a session, created by [dialog](#dialog-1).

#### Type Parameters

##### M

`M` *extends* `AnyStateMachine`

The XState machine this dialog runs.

##### E

`E` = `EventFromLogic`\<`M`\>

The event union [Dialog.send](#send) and a gated tool's
  `send`/`sendFrom` accept. Defaults to the machine's own — a dialog declared
  from a [DialogSpec](#dialogspec) supplies it directly instead, because the machine
  it builds is an implementation detail and its type carries no events.

#### Methods

##### matches()

```ts
matches(ctx: SlotHolder, state: string): boolean;
```

Whether the active state matches `state`, as `when` spells it.

###### Parameters

###### ctx

[`SlotHolder`](#slotholder)

###### state

`string`

###### Returns

`boolean`

##### position()

```ts
position(ctx: SlotHolder): DialogPosition;
```

Where this session's conversation currently is.

###### Parameters

###### ctx

[`SlotHolder`](#slotholder)

###### Returns

[`DialogPosition`](#dialogposition)

##### projection()

```ts
projection<V>(project: (position: DialogPosition) => V): StateProjection<V>;
```

A `syncState` projection of this dialog's position, so a client can render
the step the caller is on without the agent hand-rolling a sync channel.

The projector is REQUIRED, exactly as [SessionSlot.projection](#projection-1)'s is,
and for the same reason: an optional one cannot be typed without asserting
that the un-projected [DialogPosition](#dialogposition) is the caller's `V`. Project the
identity — `dialog.projection((at) => at)` — to push the whole position.

###### Type Parameters

###### V

`V`

###### Parameters

###### project

(`position`: [`DialogPosition`](#dialogposition)) => `V`

###### Returns

[`StateProjection`](#stateprojection)\<`V`\>

##### reset()

```ts
reset(ctx: SlotHolder): DialogPosition;
```

Discard this session's progress and start the dialog over.

###### Parameters

###### ctx

[`SlotHolder`](#slotholder)

###### Returns

[`DialogPosition`](#dialogposition)

##### send()

```ts
send(ctx: SlotHolder, event: E): DialogPosition;
```

Advance the dialog, and store the result.

An event the active state does not handle is IGNORED — XState's own
behaviour, kept rather than turned into a throw, because the alternative is
an agent that crashes a live call over a transition that merely was not
available. The returned position is what actually happened; compare its
`state` to know whether anything moved.

###### Parameters

###### ctx

[`SlotHolder`](#slotholder)

###### event

`E`

###### Returns

[`DialogPosition`](#dialogposition)

##### tool()

```ts
tool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(def: DialogToolDef<P, R, E>): ToolDef<P, Promise<
  | ToolFailure
| DialogToolResult<R>>>;
```

Declare a tool gated on this dialog's state. See [DialogToolDef](#dialogtooldef).

The return type is the WRAPPED one the body actually answers with, not a
bare [ToolDef](#tooldef): `InferToolOutput<typeof myTool>` is then
`DialogToolResult<R> | ToolFailure`, so a custom client renders the same
shape the tool sends instead of `unknown`. Narrowing a return type is
covariant, so a gated tool is still assignable wherever the agent's
registry wants a `ToolDef<ToolInputSchema>`.

###### Type Parameters

###### P

`P` *extends* [`ToolInputSchema`](#toolinputschema) = [`ToolInputSchema`](#toolinputschema)

###### R

`R` = `unknown`

###### Parameters

###### def

[`DialogToolDef`](#dialogtooldef)\<`P`, `R`, `E`\>

###### Returns

[`ToolDef`](#tooldef)\<`P`, `Promise`\<
  \| [`ToolFailure`](utils.md#toolfailure)
  \| [`DialogToolResult`](#dialogtoolresult)\<`R`\>\>\>

#### Properties

##### key

```ts
readonly key: string;
```

The store key this dialog's snapshot occupies. Two flows must not share one.

##### machine

```ts
readonly machine: M;
```

The machine itself, for a caller that wants to inspect or visualize it.

***

### DialogOptions

Options for [dialog](#dialog-1).

#### Properties

##### durable?

```ts
optional durable?: boolean;
```

Whether this dialog's position is stored durably. Defaults to `true` — see
[SessionSlotOptions.durable](#durable-2). A persisted snapshot is plain JSON by
construction, so there is nothing here that cannot be stored.

***

### DialogPosition

Where a dialog currently is.

#### Extended by

- [`DialogToolResult`](#dialogtoolresult)

#### Properties

##### done

```ts
readonly done: boolean;
```

Whether the machine has reached a final state.

##### instruction?

```ts
readonly optional instruction?: string;
```

The active state's `meta.instruction`, when it declares one — what the
agent is supposed to be doing here, in the words the state itself carries.

Read from the DEEPEST active state node, so a nested state's instruction
wins over its parent's rather than being merged with it.

##### state

```ts
readonly state: string;
```

The active state as a dotted path — `"verifying"`, or `"quote.pending"` for
a nested one. Parallel regions are joined with `","`.

***

### DialogSpec

A dialog's shape as a plain state map — the argument to the [dialog](#dialog-1)
overload that takes no XState machine. See [DialogStateSpec](#dialogstatespec).

#### Properties

##### initial

```ts
initial: string;
```

Which state a fresh dialog starts in.

##### states

```ts
states: Record<string, DialogStateSpec>;
```

The states, keyed by the name `when` and [DialogPosition.state](#state) use.

***

### DialogStateSpec

One state of a [DialogSpec](#dialogspec) — the plain-object form of a dialog's shape.

These are the six things every dialog in the templates actually used, and
they are not a subset chosen for convenience: a dialog's snapshot is
PERSISTED, so it must survive `structuredClone`, which rules out guards,
actions, context and invoked actors by construction. What was left was an
XState `setup({ types: {} as { events: … } })` block whose event union
restated every name already written in the `on` maps, and a
`meta: { instruction }` wrapper around every line of guidance.

**The reason to type it is a SILENT failure, not the line count.** The
instruction is read back out of `meta` untyped (`_dialog-snapshot.ts`), and
XState types `meta` as `Record<string, any>` unless a machine declares
`types: {} as { meta: … }` — which no template did. So `instructions`
(plural), or the field one nesting level off, compiled, deployed, and
produced refusals carrying no recovery text at all: exactly the failure the
`when` gate exists to prevent, arriving through the field that is supposed to
explain it. A declared `instruction?: string` makes that a typo the compiler
catches.

A dialog that needs anything beyond these six passes a machine instead — the
[dialog](#dialog-1) overload taking one is not going away, and `procedure()` is
where full XState lives.

#### Properties

##### final?

```ts
optional final?: true;
```

Whether reaching this state ENDS the dialog — XState's `type: "final"`.

##### initial?

```ts
optional initial?: string;
```

For a state with `states`: which child it starts in.

##### instruction?

```ts
optional instruction?: string;
```

What the agent is supposed to be doing here, in this state's own words.
Becomes [DialogPosition.instruction](#instruction) while the state is active, which
is what a refusal quotes and what every gated tool's result carries.

##### on?

```ts
optional on?: Record<string, string>;
```

The transitions out of this state: event name to target state, exactly as
an XState `on` map spells it. Every key here joins the event union
[Dialog.send](#send) and a gated tool's `send`/`sendFrom` accept, so an
event a spec never declares is a compile error rather than an event
silently ignored at run time.

##### states?

```ts
optional states?: Record<string, DialogStateSpec>;
```

Nested states, addressed as `parent.child` by `when` and by `matches`.

***

### DialogToolDef

The authoring shape of a gated tool — [ToolDef](#tooldef) plus the two things
that make it part of a dialog: where it may run, and what it advances.

#### Type Parameters

##### P

`P` *extends* [`ToolInputSchema`](#toolinputschema)

The tool's input schema.

##### R

`R`

What `execute` returns.

##### E

`E`

The machine's event union.

#### Methods

##### execute()

```ts
execute(args: InferSchemaOutput<P>, ctx: ToolContext): 
  | ToolFailure
  | R
| Promise<ToolFailure | R>;
```

The tool body. Runs only in one of `when`'s states.

May be async: the result is AWAITED before the failure check and the
transition, so `sendFrom` and `result` both see the settled value. Unlike
[SessionSlot.updateTool](#updatetool) there is no synchronous requirement here —
this opens no mutation window around the body, only inside `send`.

**`ToolFailure` is in the return type rather than in `R`**, which is what
lets `sendFrom` be typed over the SUCCESS value alone. A body that can fail
is the ordinary case — it is how a tool reports something the model should
recover from — and folding the failure into `R` made every `sendFrom`
narrow a value it is never handed: the failure check returns before it runs.

###### Parameters

###### args

[`InferSchemaOutput`](#inferschemaoutput)\<`P`\>

###### ctx

[`ToolContext`](#toolcontext)

###### Returns

  \| [`ToolFailure`](utils.md#toolfailure)
  \| `R`
  \| `Promise`\<[`ToolFailure`](utils.md#toolfailure) \| `R`\>

#### Properties

##### description

```ts
description: string;
```

See [ToolDef.description](#description-2) — what the model reads to decide to call it.

##### inputSchema?

```ts
optional inputSchema?: P;
```

See [ToolDef.inputSchema](#inputschema-2).

##### send?

```ts
optional send?: E;
```

The event to send once `execute` has succeeded — how the conversation moves
on. Omit both this and `sendFrom` for a tool that reads without advancing.

**Nothing is sent when `execute` returns a [ToolFailure](utils.md#toolfailure).** A tool
that failed did not do the thing, so a dialog that advanced anyway would
leave the conversation a step ahead of reality — the single most expensive
bug this primitive can have, since every later gate is then wrong too.

##### sendFrom?

```ts
optional sendFrom?: (result: Exclude<NoInfer<R>, ToolFailure>) => E | undefined;
```

The event to send, decided by the RESULT — for a tool whose outcome picks
the transition. Return `undefined` to stay put.

Separate from `send` rather than a union with it because a union of an
event and a function of one cannot be narrowed by `typeof`: an event type is
generic here, so TypeScript cannot rule out that it is itself callable, and
the check would need a cast to compile. Two fields are also the clearer
authoring surface — the static case stays a literal. Declaring both is an
error.

**`NoInfer` is what makes the parameter mean anything.** `R` is inferred
from `execute`, and a bare `(result: R) => …` here puts `R` in a SECOND
inference position — so which one wins is decided by the object literal's
source order. A `sendFrom` written ABOVE `execute` inferred `R = unknown`
from its own parameter, and then compiled: the narrowing an author wrote it
for silently stopped meaning anything, with no error anywhere and no way to
tell the two orderings apart by reading either one. `NoInfer<R>` takes this
position out of the running, so `execute` decides `R` in both orderings and
a typo'd property is a `TS2551` in both.

**`Exclude<…, ToolFailure>` is the other half, and it was already true at
run time**: the failure check returns before `sendFrom` is reached, so a
failure is never handed to it. Saying so in the type is what lets a body
declared `Order | ToolFailure` be narrowed here without the author
re-checking a case that cannot arrive.

###### Parameters

###### result

`Exclude`\<`NoInfer`\<`R`\>, [`ToolFailure`](utils.md#toolfailure)\>

###### Returns

`E` \| `undefined`

##### when

```ts
when: string | readonly string[];
```

The state(s) this tool may run in, as [DialogPosition.state](#state) spells
them. Anywhere else the body does not run and the call is refused.

Every name is checked against the machine's own states when the tool is
DECLARED, so a typo is a throw at startup rather than a tool that is
silently unreachable for the life of the agent.

***

### DialogToolResult

What a [Dialog.tool](#tool) answers on success.

#### Extends

- [`DialogPosition`](#dialogposition)

#### Type Parameters

##### R

`R`

The author's own `execute` return type, under `result`.

#### Properties

##### done

```ts
readonly done: boolean;
```

Whether the machine has reached a final state.

###### Inherited from

[`DialogPosition`](#dialogposition).[`done`](#done)

##### instruction?

```ts
readonly optional instruction?: string;
```

The active state's `meta.instruction`, when it declares one — what the
agent is supposed to be doing here, in the words the state itself carries.

Read from the DEEPEST active state node, so a nested state's instruction
wins over its parent's rather than being merged with it.

###### Inherited from

[`DialogPosition`](#dialogposition).[`instruction`](#instruction)

##### result

```ts
readonly result: R;
```

Whatever the tool's own `execute` returned.

##### state

```ts
readonly state: string;
```

The active state as a dotted path — `"verifying"`, or `"quote.pending"` for
a nested one. Parallel regions are joined with `","`.

###### Inherited from

[`DialogPosition`](#dialogposition).[`state`](#state)

***

### PipelineVoiceTuning

Pipeline-mode voice-UX tuning, extended by [AgentDef](#agentdef).

#### Extended by

- [`AgentDef`](#agentdef)

#### Properties

##### deadAirCoverMs?

```ts
optional deadAirCoverMs?: number;
```

Pipeline mode only. How long a turn may send nothing to the caller before
the transport speaks a short filler, so a long tool chain doesn't sound
like a dropped call. MEASURED silence, so a prompt reply pays nothing; `0`
disables. The wording is internal and must stay purely declarative — see
`DEAD_AIR_COVER_PHRASES` for why.

###### Default Value

`5000` (`DEFAULT_DEAD_AIR_COVER_MS`)

##### errorPhrase?

```ts
optional errorPhrase?: string;
```

Pipeline mode only. Phrase spoken when the turn's LLM stream fails, so a
provider outage hands the conversation back instead of going silent — a
failed turn produces no text, so nothing would otherwise reach TTS. Set
`""` to disable.

###### Default Value

`"Sorry, I had a problem just then. Could you say that
again?"` (`DEFAULT_ERROR_PHRASE`)

##### interruptionMinDurationMs?

```ts
optional interruptionMinDurationMs?: number;
```

Pipeline mode only. Minimum sustained speech (ms since the utterance's
first interim transcript) before an interim-triggered barge-in aborts the
agent's reply — a duration gate alongside `minBargeInWords`, mirroring
LiveKit's `min_interruption_duration`. Committed turns (STT finals) are
never gated. Set 0 to disable the gate.

###### Default Value

`500` (`DEFAULT_INTERRUPTION_MIN_DURATION_MS`)

##### minBargeInWords?

```ts
optional minBargeInWords?: number;
```

Pipeline mode only. Minimum words in an interim transcript before user
speech barges in on (aborts) the agent's in-flight reply. Set 1 to
interrupt on any word.

###### Default Value

`2` (`DEFAULT_MIN_BARGE_IN_WORDS`) — so one-word
backchannels ("yeah", "mm-hmm") don't cut the agent off.

##### preemptiveGeneration?

```ts
optional preemptiveGeneration?: boolean;
```

Pipeline mode only. Start generating the reply from a high-confidence
INTERIM transcript, and adopt that already-running stream when the
committed final turns out to say the same thing.

###### Default Value

`false` — measured on a tool-calling agent and not worth its
cost there. Set `true` where the arithmetic plausibly differs: a text-heavy
agent, or a longer head start from later endpointing.

###### Remarks

**Why it is off.** A `headStartMs`/adoption-rate log over a tau2-bench
retail run: 16 speculations started, 14 adopted at a p50 0.44s head start,
and 5 of those 14 (36%) poisoned after adoption by a tool call — unusable
whole, so the generation is discarded and the request reissued, each having
burned p50 0.69s first. Net +8ms per caller turn against a p50 first word of
~1.0s, for 44% of its LLM requests thrown away.

The head start does not survive contact with time-to-first-token: 0.44s
against a p50 of 1.10s, so at adoption the speculation has generated
nothing and whether its first part will be text or a tool call cannot be
known then. A gate on "has it produced text" was tried and reverted — it
rejects essentially every adoption, keeping the wasted request and losing
the benefit.

Its reach is bounded independently of that: across 815 replies in two
tau2-bench retail runs, 28-33% of replies called a tool at all (the
distribution recorded on `DEFAULT_MAX_STEPS`), so at most the
remaining 67-72% can ever be accelerated.

**What it structurally cannot do**, by construction rather than by flag:
a speculation never reaches TTS, never
emits a client frame, never writes either history view, and never EXECUTES
a tool — its tool set is declaration-only, so the model cannot continue past
a tool call, and a speculation that reaches one is discarded whole. Adoption
requires the final to match the speculated text after normalization
(case/punctuation only); an extension, a truncation or a revision all
discard and the turn runs exactly as it does with the flag off. At most 2
speculations per utterance. So the worst case is one extra billed LLM
request for that utterance.

Turning it back on by default is owed a tau2-bench run at the same tasks
and seed showing no reward regression.

##### resumeFalseInterruption?

```ts
optional resumeFalseInterruption?: boolean;
```

Pipeline mode only. Resume the agent's reply when a barge-in aborts it and
no user turn ever commits (STT noise, a hallucinated partial) — the
interruption was a false alarm and the agent would otherwise fall silent
mid-thought.

###### Default Value

`true`; `false` disables recovery.

The WAIT is not an author knob: a resume must not race the caller's real
turn, whose final the STT withholds for an endpointing window the transport
cannot see, so it fires when the transcript stream goes quiet with no final
rather than on a deadline of its own.

##### startFailurePhrase?

```ts
optional startFailurePhrase?: string;
```

Pipeline mode only. Phrase spoken when a provider fails to open, so a session that cannot
start says so instead of holding an open line in silence. Only reachable when TTS itself
came up — the usual case, since STT and TTS open independently. Set `""`
to disable.

###### Default Value

`"I am sorry, I am having trouble with my connection and
cannot hear you. Please hang up and call back."`
(`DEFAULT_START_FAILURE_PHRASE`)

***

### Procedure

A machine that can be run as a unit of work, created by [procedure](#procedure-2).

#### Type Parameters

##### M

`M` *extends* `AnyStateMachine`

The XState machine.

#### Methods

##### run()

```ts
run(input: InputFrom<M>, options?: ProcedureRunOptions): Promise<OutputFrom<M>>;
```

Run to completion and resolve with the machine's `output`.

Rejects when the machine ENDS badly rather than when it decides badly: an
invoked actor whose promise rejects with no `onError` stops the machine and
rejects here, and so does an aborted or otherwise unfinished run. A machine
that reached a final state resolves — so every way of *failing at the work*
should be a final state whose output says so, which is what keeps a procedure's
failures inspectable instead of thrown.

###### Parameters

###### input

`InputFrom`\<`M`\>

###### options?

[`ProcedureRunOptions`](#procedurerunoptions)

###### Returns

`Promise`\<`OutputFrom`\<`M`\>\>

#### Properties

##### machine

```ts
readonly machine: M;
```

The machine itself, for a caller that wants to inspect or visualize it.

***

### ProcedureRunOptions

Options for one [Procedure.run](#run).

#### Properties

##### signal?

```ts
optional signal?: AbortSignal;
```

Abort the run — pass `ctx.signal` and a barge-in stops the procedure.

This is the reason a long procedure should be run through here rather than by
hand. A CRAG loop is five to nine model calls; a caller who interrupts on
the second is charged for the remaining seven unless something stops it, and
`ctx.signal` is already aborted on barge-in, reset and session stop. Aborting
stops the actor, which cancels nothing already in flight but issues nothing
further, and `run` then throws rather than returning a half-built output.

***

### ProviderCredentialOptions

The credential override every provider descriptor accepts.

Names an env VARIABLE holding this stage's key, replacing the provider
default (`DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY`, …). It names a variable
and never a key, so the descriptor stays secret-free and safe to serialize
across the CLI → server → guest boundary. The variable must be present in
the agent's env (`.env`, or `aai secret put`), like any other credential.

#### Remarks

**Every provider options interface extends this, because the host has always
honoured the field on every provider.** `descriptorEnvVar()` in
`@alexkroman1/aai-runtime` reads `apiKeyEnv` off any descriptor's options
through an untyped cast, so all thirteen factories accepted it at runtime
while only the four AssemblyAI options types could spell it — a shape that
cost `aai:s2s` epoch 1, where the field was added to one stage and left off
the rest.

The argument for keeping it AssemblyAI-only was that AssemblyAI keys are
environment-scoped, so a mixed staging/production pipeline needs two live at
once, and no other vendor has that problem. True, and not the whole test: a
type that cannot spell what the runtime accepts is wrong regardless of who
needs it, and per-stage key separation is equally the answer for two accounts
with one vendor, for per-tenant keys, and for a rotation that runs both keys
briefly.

#### Extended by

- [`AssemblyAIS2sOptions`](#assemblyais2soptions)
- [`AssemblyAISttOptions`](stt.md#assemblyaisttoptions)
- [`DeepgramSttOptions`](stt.md#deepgramsttoptions)
- [`ElevenLabsSttOptions`](stt.md#elevenlabssttoptions)
- [`SonioxSttOptions`](stt.md#sonioxsttoptions)
- [`AssemblyAITtsOptions`](tts.md#assemblyaittsoptions)
- [`CartesiaTtsOptions`](tts.md#cartesiattsoptions)
- [`RimeTtsOptions`](tts.md#rimettsoptions)
- [`AssemblyAILlmOptions`](llm.md#assemblyaillmoptions)
- [`ModelOptions`](llm.md#modeloptions)
- [`OpenAIS2sOptions`](s2s.md#openais2soptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

***

### ProviderDescriptor

Base shape for a provider descriptor. A `kind` tag + opaque `options`
payload lets the host registry pick the right resolver and pass the
caller's options through verbatim.

#### Type Parameters

##### Kind

`Kind` *extends* `string`

##### Options

`Options`

#### Properties

##### kind

```ts
readonly kind: Kind;
```

##### options

```ts
readonly options: Options;
```

***

### ResolveOneOptions

Options for [resolveOne](#resolveone).

#### Type Parameters

##### T

`T`

#### Properties

##### describe

```ts
describe: (candidate: T) => string;
```

One candidate as the model should hear it read back — this is what a
failure lists, so it has to be enough to choose between them out loud.

###### Parameters

###### candidate

`T`

###### Returns

`string`

##### label?

```ts
optional label?: string;
```

What the candidates are called, for the failure sentences. Defaults to
`"option"`. Singular: the plural is formed with `s`.

##### score?

```ts
optional score?: (candidate: T, text: string) => number;
```

How well a candidate matches the utterance — higher wins, `0` means no
match at all. Optional: with no scorer, an utterance that names no position
resolves only when there is exactly one candidate.

`text` is the utterance lower-cased, since every scorer wants that.

###### Parameters

###### candidate

`T`

###### text

`string`

###### Returns

`number`

***

### SessionSlot

A named slot of per-session state, created by [sessionSlot](#sessionslot-1).

#### Type Parameters

##### K

`K` *extends* `string`

The key this slot occupies in the session's state.

##### T

`T`

The value's shape.

#### Methods

##### create()

```ts
create(): T;
```

A fresh default value, as `get` would install one.

###### Returns

`T`

##### get()

```ts
get(ctx: SlotHolder): DeepReadonly<T>;
```

This session's value, installing the default on first access.

**Readonly all the way down, and frozen to match.** Mutating what this
returns is a compile error at every depth — `cart.items.push(x)` as much as
`cart.total = 0` — and a `TypeError` for a caller with no types, because a
mutation applied here is applied to a value nothing is going to store.
Every write goes through [SessionSlot.update](#update). See
[DeepReadonly](#deepreadonly) for why the type is deep rather than shallow.

###### Parameters

###### ctx

[`SlotHolder`](#slotholder)

###### Returns

[`DeepReadonly`](#deepreadonly)\<`T`\>

##### projection()

```ts
projection<V>(project: (value: DeepReadonly<T>) => V): StateProjection<V>;
```

A `syncState` projection over this slot: read the value (defaulting when
the session has not touched it), then project.

The result is CALLABLE as well as declarable, which is what lets a client
derive its own empty state from the same function the server pushes —
`slot.projection(view)()` is the pre-first-tool-call frame. Declaring it is
`agent({ syncState: slot.projection(view) })`, and an agent with more than
one slot passes an array; the frame carries the merge.

`project` receives a REAL value, so a projection needs no optional chaining
for the moment before the first tool call.

###### Type Parameters

###### V

`V`

###### Parameters

###### project

(`value`: [`DeepReadonly`](#deepreadonly)\<`T`\>) => `V`

###### Returns

[`StateProjection`](#stateprojection)\<`V`\>

###### Example

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";

const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));

export default agent({
  name: "Shop",
  syncState: cartSlot.projection((cart) => ({ count: cart.items.length })),
});
```

##### reset()

```ts
reset(ctx: SlotHolder): DeepReadonly<T>;
```

Discard this session's value and install a fresh default, and return it.

###### Parameters

###### ctx

[`SlotHolder`](#slotholder)

###### Returns

[`DeepReadonly`](#deepreadonly)\<`T`\>

##### set()

```ts
set(ctx: SlotHolder, value: T): DeepReadonly<T>;
```

Replace this session's value wholesale (a load, an import, a restore), and
return it as `get` would.

**The caller's object is COPIED, not adopted.** A durable slot freezes what
it stores, and this method's own examples — a load, an import, a restore —
are exactly the cases where the caller still holds a reference to what it
passed: freezing in place turned an unrelated later line
(`imported.items.push(...)`) into a `TypeError` from a stack that names
nothing about this slot. [SessionSlot.update](#update) was already safe because
its draft is a copy; this is the same rule applied to the other writer.

###### Parameters

###### ctx

[`SlotHolder`](#slotholder)

###### value

`T`

###### Returns

[`DeepReadonly`](#deepreadonly)\<`T`\>

##### tool()

```ts
tool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(def: SlotToolDef<P, DeepReadonly<T>, R>): ToolDef<P, R>;
```

Define a READ-ONLY tool over this slot: `execute` is handed the frozen
value, so the body needs neither a context annotation nor an opening
`slot.get(ctx)`.

A body that mutates wants [SessionSlot.updateTool](#updatetool). This one's value
is [DeepReadonly](#deepreadonly)`<T>`, so choosing wrong is a compile error — at any
depth — rather than a write that goes nowhere or throws.

**`R` is threaded out**, as [tool](#tool-1)'s is: `R` used to be bound here and
thrown away at the interface, so `InferToolOutput` answered `unknown` for
exactly the tools an agent most often writes. Narrowing a return type is
covariant, so the tool stays assignable to `ToolDef<ToolInputSchema>`.

###### Type Parameters

###### P

`P` *extends* [`ToolInputSchema`](#toolinputschema) = [`ToolInputSchema`](#toolinputschema)

###### R

`R` = `unknown`

###### Parameters

###### def

[`SlotToolDef`](#slottooldef)\<`P`, [`DeepReadonly`](#deepreadonly)\<`T`\>, `R`\>

###### Returns

[`ToolDef`](#tooldef)\<`P`, `R`\>

###### Example

```ts
import { sessionSlot } from "@alexkroman1/aai";
import { z } from "zod";

const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));

export default cartSlot.tool({
  description: "How many items are in the cart",
  inputSchema: z.object({}),
  execute: (_args, cart) => ({ count: cart.items.length }),
});
```

##### update()

```ts
update<R>(ctx: SlotHolder, mutate: (draft: T) => R): RejectThenableResult<R>;
```

Mutate this session's value, and store the result.

`mutate` is handed a mutable DRAFT — a private copy of the current value —
and whatever it leaves behind becomes the stored value when it returns.
Resolves to whatever `mutate` returned, so a tool body can compute its
result and its mutation in one pass.

**It is SYNCHRONOUS, and that is the invariant, not an implementation
detail.** There is no await between the read and the write, so a
read-modify-write cannot interleave with another JS turn — which matters
because the LLM loop runs a step's tool calls CONCURRENTLY. Await in FRONT
of the mutation instead:

```ts
import { sessionSlot, tool } from "@alexkroman1/aai";
import { z } from "zod";

const cartSlot = sessionSlot("cart", () => ({ items: [] as string[], quote: 0 }));

export default tool({
  description: "Price the cart",
  inputSchema: z.object({}),
  execute: async (_args, ctx) => {
    const quote = await ctx.generate({ prompt: "price it" });   // await first
    return cartSlot.update(ctx, (cart) => {                     // then mutate
      cart.quote = Number(quote.text);
      return { quote: cart.quote };
    });
  },
});
```

A mutator that throws stores NOTHING: the draft is discarded and the
mutator's error propagates. The `after` hook does not run either — see
[SessionSlotOptions.after](#after-1).

For serialized work that is not a slot mutation — an external resource, a
key that isn't the session id, or a mutation that must fail rather than
queue — reach for `createKeyedLock`/`withLock`. They are public for exactly
that, and this method no longer takes a lock at all: a synchronous window
has nothing to serialize.

###### Type Parameters

###### R

`R`

###### Parameters

###### ctx

[`SlotHolder`](#slotholder)

###### mutate

(`draft`: `T`) => `R`

###### Returns

`RejectThenableResult`\<`R`\>

##### updateTool()

```ts
updateTool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(def: SlotToolDef<P, T, R> & RejectThenable<R>): ToolDef<P, R>;
```

Define a MUTATING tool over this slot: the body runs inside
[SessionSlot.update](#update), so it is handed a draft and whatever it leaves
behind is stored.

The body must therefore be SYNCHRONOUS. A tool that has to await does the
awaiting in an ordinary `tool()` and calls `update` afterwards; see
`update`'s example.

That is enforced at RUN TIME rather than in the type, and the reason is
worth knowing before "fixing" it: a conditional return type
(`R extends Promise<unknown> ? never : R`) cannot be satisfied by a generic
WRAPPER around this method, and a per-agent wrapper is the main way it gets
used (`retail`'s `retailTool`). The runtime check has the better message
anyway, and it is the half a user's project actually runs — neither bundler
type-checks user code.

**It fires at DECLARATION for the common case.** An `async` body is an
`AsyncFunction`, visible the moment the module loads — under `aai dev`, in
the build, in the agent's own spec. A sync function that RETURNS a promise
is the other half, and only the call can catch it.

###### Type Parameters

###### P

`P` *extends* [`ToolInputSchema`](#toolinputschema) = [`ToolInputSchema`](#toolinputschema)

###### R

`R` = `unknown`

###### Parameters

###### def

[`SlotToolDef`](#slottooldef)\<`P`, `T`, `R`\> & `RejectThenable`\<`R`\>

###### Returns

[`ToolDef`](#tooldef)\<`P`, `R`\>

###### Example

```ts
import { sessionSlot } from "@alexkroman1/aai";
import { z } from "zod";

const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));

export default cartSlot.updateTool({
  description: "Add an item to the cart",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }, cart) => {
    cart.items.push(item);
    return { count: cart.items.length };
  },
});
```

#### Properties

##### durable

```ts
readonly durable: boolean;
```

Whether this slot's value is stored durably. `true` unless the slot
declared otherwise — see [SessionSlotOptions.durable](#durable-2).

##### key

```ts
readonly key: K;
```

The store key this slot occupies. Two slots must not share one.

***

### SessionSlotOptions

Options for [sessionSlot](#sessionslot-1).

#### Type Parameters

##### T

`T`

##### After

`After` = `void`

#### Properties

##### after?

```ts
optional after?: (draft: T) => After & RejectThenable<After>;
```

Invariant restoration, run on the draft at the end of every successful
[SessionSlot.update](#update) — pruning growth, recalculating a derived field.

It exists so those rules live with the slot rather than being re-listed at
every mutating call site, which is how one gets forgotten. Because it runs
inside the mutation window, it sees the complete value about to be stored
and may mutate it in place.

**It does NOT run when `mutate` throws.** A mutator that failed part-way
may have left the draft in a shape the hook itself cannot handle, and an
error thrown from the hook would replace the one that actually explains the
failure. Nothing is stored in that case either.

**It runs INSIDE the mutation window, so it is synchronous too** — an
`async` hook is a compile error naming the rule — see `RejectThenable`,
which is off the docs for the reason the `AgentParams` misuse types are:
you meet it in what tsc prints, never by name.
The `After` parameter exists only to carry that check: it is inferred from
the hook and defaults to `void`, so a caller never writes it.

##### durable?

```ts
optional durable?: boolean;
```

Whether this slot's value is STORED. Defaults to `true`.

`false` declares a VIRTUAL slot: a per-session box whose contents are
neither checked, frozen, nor committed, and which does not survive the
process. That is the right shape for a value whose lifetime is one call and
which could not be stored anyway — a provider handle, an open socket, a
cached client.

It is a property of the slot's DECLARATION rather than a per-value opt-out,
which is what makes it a decision the author makes once instead of a check
somebody has to remember to skip. Note `get` on a virtual slot returns the
live value: there is nothing to protect it from, since nothing is going to
store a copy of it.

***

### SlotToolDef

The authoring shape of a slot-backed tool: [ToolDef](#tooldef) with the slot's
value handed to `execute` directly.

`value` comes SECOND because it is what a slot-backed tool body actually
uses; most take `(args, cart)` and never mention `ctx` at all, which is the
point. Putting it there rather than third cannot be got wrong silently — a
body converted from `tool()` that still names its second parameter `ctx` is a
type error the first time it reads `ctx.env`, since `V` is not a
[ToolContext](#toolcontext).

#### Type Parameters

##### P

`P` *extends* [`ToolInputSchema`](#toolinputschema)

##### V

`V`

What `execute` is handed: a deep-frozen
  [DeepReadonly](#deepreadonly)`<T>` from [SessionSlot.tool](#tool-1), a mutable draft
  from [SessionSlot.updateTool](#updatetool).

##### R

`R`

#### Methods

##### execute()

```ts
execute(
   args: InferSchemaOutput<P>, 
   value: V, 
   ctx: ToolContext
): R;
```

The tool body, handed this session's slot value alongside the usual args.

###### Parameters

###### args

[`InferSchemaOutput`](#inferschemaoutput)\<`P`\>

###### value

`V`

###### ctx

[`ToolContext`](#toolcontext)

###### Returns

`R`

#### Properties

##### description

```ts
description: string;
```

See [ToolDef.description](#description-2) — what the model reads to decide to call it.

##### inputSchema?

```ts
optional inputSchema?: P;
```

See [ToolDef.inputSchema](#inputschema-2).

***

### StateProjection()

One slot's contribution to the `agent_state` frame — what
[SessionSlot.projection](#projection-1) returns and what `agent({ syncState })` takes.

It is a FUNCTION carrying the two facts the runtime needs, rather than a
plain record, and the callable half is load-bearing at both ends. The server
calls it with whatever the store holds; a `client.tsx` calls it with nothing
to derive the frame it renders before the first tool call, from the same
function — so a field added to the projection reaches the first render
instead of being missing until something changes.

#### Type Parameters

##### V

`V` = `unknown`

```ts
StateProjection(value?: unknown): V;
```

Project a stored value, or the slot's default when there is none.

#### Parameters

##### value?

`unknown`

#### Returns

`V`

#### Properties

##### create

```ts
readonly create: () => unknown;
```

The slot's default, for a session that has not touched it.

###### Returns

`unknown`

##### key

```ts
readonly key: string;
```

The slot key whose value this projects.

***

### SubagentDef

A subagent definition — what [subagent](#subagent) returns and
[DelegateFn](#delegatefn) runs.

Every field except `name` and `systemPrompt` is optional, and the defaults
are the parent agent's: the same LLM descriptor, no tools, and
the framework default (`DEFAULT_MAX_STEPS`) steps.

#### Properties

##### builtinTools?

```ts
optional builtinTools?: readonly BuiltinTool[];
```

Builtins this subagent may call, resolved exactly as `agent({
builtinTools })` resolves them. Independent of the parent's: a parent that
enables none can still delegate to a subagent that searches the web.

##### llm?

```ts
optional llm?: string | LlmProvider;
```

LLM for this subagent: a descriptor from `@alexkroman1/aai/llm`, or a
model-id string — the same shorthand as `agent({ llm })` and
[GenerateOptions.llm](#llm-2). Defaults to the parent agent's own LLM.

Naming a cheaper model here is the usual reason to set it: a subagent
doing lookups is spending most of its tokens on tool results, not on
reasoning.

##### maxOutputTokens?

```ts
optional maxOutputTokens?: number;
```

Cap on generated tokens per step, passed through to the provider.

##### maxSteps?

```ts
optional maxSteps?: number;
```

Tool-calling steps this subagent may take before it must answer. Defaults
to the framework's `DEFAULT_MAX_STEPS`.

The budget is the mechanism: a subagent told to "keep looking until sure"
is a subagent whose cost nobody can quote. Past the cap it is asked for
its answer with tools withheld, so a capped run still returns prose rather
than stopping mid-chain.

##### name

```ts
name: string;
```

What this subagent is called. It reaches the model only as the id on the
subagent's own requests; its reader is a log line and a failure message
("subagent \"researcher\" ran out of steps"), which is why it is required
and why an anonymous subagent is not expressible.

##### systemPrompt

```ts
systemPrompt: string;
```

The subagent's system prompt.

**Tell it to summarize.** The parent gets [DelegateResult.text](#text-1),
which is the subagent's FINAL message — so a subagent that ends its run by
saying "Done." has thrown away everything it learned, and no amount of
step budget recovers it. This is the single most common way a subagent
disappoints, and the remedy is one sentence in the systemPrompt.

##### temperature?

```ts
optional temperature?: number;
```

Sampling temperature passed through to the provider.

##### tools?

```ts
optional tools?: Readonly<Record<string, ToolDef>>;
```

The tools this subagent may call, by the name the model calls them by.

A MAP rather than the filesystem registration `agent()` uses, and the
difference is deliberate: `tools/` declares what the CALLER can reach, and
this declares the strictly narrower set one delegated task can reach. A
subagent with no entry here and no `builtinTools` is a pure reasoning
pass — legal, and occasionally what you want.

***

### SubagentToolCall

One tool call a subagent made, as reported back to the caller.

#### Properties

##### input

```ts
input: unknown;
```

The arguments it was called with.

##### name

```ts
name: string;
```

The tool's name, as the subagent's model called it.

## Type Aliases

### AgentParams

```ts
type AgentParams = 
  | PipelineAgentParams
  | S2sAgentParams
  | TextAgentParams
  | StaticAgentParamsCore;
```

The author-facing parameter shape of [agent](#agent): every [AgentDef](#agentdef)
field, with the defaulted ones optional.

Derived from `AgentDef` rather than re-declared, so a field added there is
automatically declarable here — the inline re-declaration this replaces let
fields (`send`, `state`) ship as runtime-working but excess-property errors
for authors, because neither bundler typechecks user code. Field docs live
on [AgentDef](#agentdef) and carry through the mapped types.

Four author-facing conveniences widen the derived shape (all normalized
away by `agent()`, so `AgentDef` stays canonical):

- `system` — alias of `systemPrompt`, matching the Vercel AI SDK's field
  name. Setting both is an error.
- `llm` also accepts a model-id string: `"creator/model"` routes through
  the Vercel AI Gateway (`AI_GATEWAY_API_KEY`), a bare id through the
  AssemblyAI LLM Gateway (`ASSEMBLYAI_API_KEY`).
- `voice` — the TTS voice for the default AssemblyAI pipeline, desugared
  to `tts: assemblyAITts({ voice })`. Only valid when no explicit `tts`
  descriptor is set (the voice rides on the descriptor there) and never
  in S2S mode (the S2S descriptor owns its voice).
- `minTurnSilenceMs` / `maxTurnSilenceMs` — the end-of-turn window for the
  default AssemblyAI STT stage, desugared to `stt: assemblyAIStt({ … })`.
  Same rule as `voice`: only valid when no explicit `stt` descriptor is set.
  `maxTurnSilenceMs` is the pause-tolerance knob, and it is here because it
  is the highest-value tuning an agent has and used to be the highest-friction
  to express — one number cost a whole stage descriptor, which then silently
  dropped whatever else the default fill would have supplied.

Pipeline stages are individually optional: declare any subset of
`stt`/`llm`/`tts` and the unset stages run on the default all-AssemblyAI
pipeline. The shape is a union over the three session modes — pipeline,
S2S ([S2sAgentParams](#s2sagentparams)) and text ([TextAgentParams](#textagentparams)) — so a
field belonging to another mode fails the build with a message naming the
rule (`PipelineOnlyMisuse`) rather than failing at the first
`aai dev`/`aai deploy`. Configs that never went through `agent()` are
still caught when `toAgentConfig` runs in the bundle entry.

The fourth arm ([StaticAgentParams](#staticagentparams)) is the WORKFLOW APP, and it is
keyed on the front door rather than on a session mode: `page: "static"` has
no session at all, so every field the other three arms exist to arbitrate
between is inert there. [workflowApp](#workflowapp) is the same arm with the
discriminant already set.

***

### AssemblyAITtsVoice

```ts
type AssemblyAITtsVoice = 
  | AssemblyAITtsVoiceId
| string & Record<never, never>;
```

A voice id from [ASSEMBLYAI\_TTS\_VOICES](#assemblyai_tts_voices).

The `(string & {})` arm is deliberate: the catalog is the service's, not
ours, so a voice added after this release must still compile, and so must
a deprecated one an existing agent already names. It keeps the current
names visible at the call site without turning a stale SDK into a build
failure.

**So this type is AUTOCOMPLETE, not a guard, and there is no runtime assert
to pair with it** the way `assertAssemblyAITtsLanguage` pairs with
[AssemblyAITtsLanguage](tts.md#assemblyaittslanguage). The two are not the same job: the language
map is a TRANSLATION this SDK owns (an ISO code the service has never heard
of, rendered as a name it accepts), so a code outside it cannot be sent at
all and rejecting it is a fact about this package. The voice catalog is the
SERVICE's, and a snapshot of it goes stale between releases — an assert
would refuse a voice AssemblyAI shipped last week, which is the same
silent-mute failure from the other side. Read the catalog; do not expect the
compiler to check you did.

***

### BuiltinTool

```ts
type BuiltinTool = 
  | "web_search"
  | "visit_webpage"
  | "get_page_design"
  | "fetch_json"
  | "run_code"
  | "think"
  | "remember"
  | "recall"
  | "calculate";
```

Identifier for a built-in server-side tool.

Built-in tools run on the host process (not inside the sandboxed worker)
and provide capabilities like web search, code execution, and API access.

- `"web_search"` — Search the web for current information, facts, or news.
- `"visit_webpage"` — Fetch a URL and return its content as clean text.
- `"get_page_design"` — Fetch a URL's raw HTML and CSS (markup, style blocks,
  linked stylesheets) to study or mimic a site's visual design.
- `"fetch_json"` — Call a REST API endpoint and return the JSON response.
- `"run_code"` — Execute JavaScript in a sandbox for calculations and data processing.
- `"think"` — Private no-op scratchpad for policy checks and planning (never spoken).
- `"remember"` — Save a confirmed fact (ID, code, date) to private session notes.
- `"recall"` — Read back facts saved with `remember`.
- `"calculate"` — Safely evaluate an arithmetic expression (no code execution).

When `builtinTools` is not set, NONE are enabled
(`DEFAULT_BUILTIN_TOOLS` is empty) — a built-in is something an agent
asks for rather than something it has to notice and switch off. Name the
ones you want; `[]` and omitting the field mean the same thing.

***

### DeepReadonly

```ts
type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly infer E[] ? readonly DeepReadonly<E>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
```

`Readonly<T>`, all the way down.

**The type a slot's reading half hands out, and the runtime it describes.**
`freezeStorable` (`sdk/session-state.ts`) walks a durable value on every
write and calls `Object.freeze` on every array and every nested object, so
the value a reader holds is deep-frozen and every mutation of it is a
`TypeError` in strict mode. `Readonly<T>` described only the top level, which
left the runtime STRICTER THAN THE TYPE — `game.inventory.push(item)` and
`game.flags[key] = true` both compiled, and both threw on the first call.
Two shipped templates did exactly that, in tools nothing in the repo ran.

The cost is real and was the reason for the shallow type: a deep readonly
DOES propagate, because TypeScript ignores readonly modifiers on properties
in assignability but NOT on arrays — `readonly string[]` is not assignable to
`string[]`. So a domain helper an agent's own modules declare
(`orderTotal(cart: Cart)`) has to take `DeepReadonly<Cart>` (or its own
readonly shape) to keep accepting a slot read. That is a compile error where
the alternative is a `TypeError` at the first call in production, and it
points at the helper that would have mutated.

Functions pass through untouched: a virtual slot (`durable: false`) is the
only one that can hold one, and nothing there is frozen.

#### Type Parameters

##### T

`T`

***

### DefaultToolResult

```ts
type DefaultToolResult = any;
```

Default type of a tool result observed on the client (`useToolResult`) —
`any`, so untyped reads compile. Pass the shape —
`useToolResult<Quote>("get_quote", …)` — for real checking.

#### Remarks

`any` because a tool result is the author's own return value
round-tripped through JSON — the client already knows its shape, and the
framework cannot. The strict default (`unknown`) made reading one field a
compile error in a client that runs correctly, which blocked publishing
once `aai build` type-checked.

***

### DelegateFn

```ts
type DelegateFn = (subagent: SubagentDef, options: DelegateOptions) => Promise<DelegateResult>;
```

Run a subagent to completion — the signature of `ctx.delegate`.

Rejects when the run cannot be started (no LLM configured or named, an
unknown builtin) and when the parent turn is cancelled. A subagent whose own
TOOL fails does not reject: the failure goes back to the subagent as a tool
result, exactly as it would in the parent loop, and the subagent gets to
recover from it.

#### Parameters

##### subagent

[`SubagentDef`](#subagentdef)

##### options

[`DelegateOptions`](#delegateoptions)

#### Returns

`Promise`\<[`DelegateResult`](#delegateresult)\>

***

### DialogEvent

```ts
type DialogEvent<S extends DialogSpec> = EventOf<NamesInMap<S["states"]>>;
```

The event union a [DialogSpec](#dialogspec) declares — synthesized from its `on`
keys at every depth.

This is what a spec-declared dialog gets INSTEAD of the `setup({ types: {} as
{ events: … } })` block it replaces: the names are already written in the
`on` maps, so restating them is a second source of truth that can disagree
with the first. `dialog.send`, `send` and `sendFrom` are typed against it, so
a misspelled event is a compile error at the call site rather than an event
XState quietly ignores.

#### Type Parameters

##### S

`S` *extends* [`DialogSpec`](#dialogspec)

***

### GenerateFn

```ts
type GenerateFn = {
<S>  (options: GenerateOptions & {
  schema: S;
}): Promise<GenerateObjectResult<InferSchemaOutput<S>>>;
  (options: GenerateOptions): Promise<GenerateResult>;
};
```

One-shot LLM generation — the signature of `ctx.generate`. A call with a
Standard Schema `schema` returns a result whose `object` is typed by that
schema and non-optional; a plain-JSON-Schema or schemaless call returns
[GenerateResult](#generateresult), whose `object` is `unknown` and must be narrowed.

#### Call Signature

```ts
<S extends StandardSchemaV1<unknown, unknown>>(options: GenerateOptions & {
  schema: S;
}): Promise<GenerateObjectResult<InferSchemaOutput<S>>>;
```

##### Type Parameters

###### S

`S` *extends* `StandardSchemaV1`\<`unknown`, `unknown`\>

##### Parameters

###### options

[`GenerateOptions`](#generateoptions) & \{
  `schema`: `S`;
\}

##### Returns

`Promise`\<[`GenerateObjectResult`](#generateobjectresult)\<[`InferSchemaOutput`](#inferschemaoutput)\<`S`\>\>\>

#### Call Signature

```ts
(options: GenerateOptions): Promise<GenerateResult>;
```

##### Parameters

###### options

[`GenerateOptions`](#generateoptions)

##### Returns

`Promise`\<[`GenerateResult`](#generateresult)\>

***

### GenerateObjectResult

```ts
type GenerateObjectResult<T> = {
  object: T;
  text: string;
};
```

Result of a generation call that passed a Standard Schema — `object` is
REQUIRED, matching what the host guarantees.

Split from [GenerateResult](#generateresult) rather than expressed as
`GenerateResult<T>` with an optional `object`: the optionality survived the
typed overload, so the one spelling the overload exists to reward —
`const { object } = await ctx.generate({ prompt, schema })` — needed a `!`
or an `if` before any field could be read, even though `host/generate.ts`
returns `{ text, object }` unconditionally on that path.

#### Type Parameters

##### T

`T`

#### Properties

##### object

```ts
object: T;
```

The schema-validated object. Always present on this overload.

##### text

```ts
text: string;
```

The generated text — the JSON-stringified object.

***

### GenerateOptions

```ts
type GenerateOptions = {
  llm?: LlmProvider | string;
  maxOutputTokens?: number;
  prompt: string;
  schema?: StandardSchemaV1 | Record<string, unknown>;
  system?: string;
  temperature?: number;
};
```

Options for one LLM generation call.

No `signal`: the call is already bound to `ctx.signal` by the runtime — see
the module doc for why a field here would be a second, competing one.

#### Properties

##### llm?

```ts
optional llm?: LlmProvider | string;
```

LLM provider for this call: a descriptor from `@alexkroman1/aai/llm`,
or a model-id string (`"creator/model"` routes through the Vercel AI
Gateway; a bare id through the AssemblyAI LLM Gateway — same shorthand
as `agent({ llm })`). Defaults to the agent's own pipeline `llm`.
Credentials resolve from the agent's env — an S2S agent can use
`generate` by naming a provider whose API key it holds as a secret.

##### maxOutputTokens?

```ts
optional maxOutputTokens?: number;
```

Cap on generated tokens passed through to the provider.

##### prompt

```ts
prompt: string;
```

The user prompt for this call.

##### schema?

```ts
optional schema?: StandardSchemaV1 | Record<string, unknown>;
```

Schema for structured output. When set, the model is constrained to the
schema and the result's `object` carries the parsed value. Accepts a
Zod schema (or any Standard Schema convertible to JSON Schema) — the
typed result follows from it — or a plain JSON Schema object, in which
case `object` is `unknown`.

##### system?

```ts
optional system?: string;
```

Optional system prompt.

##### temperature?

```ts
optional temperature?: number;
```

Sampling temperature passed through to the provider.

***

### GenerateResult

```ts
type GenerateResult = {
  object?: unknown;
  text: string;
};
```

Result of one LLM generation call without a Standard Schema — text only.

`object` is declared as optional-and-`unknown` rather than omitted because
this is also what a PLAIN JSON Schema call returns: the host does produce an
object there, but nothing types it, so a caller must narrow before reading.

#### Properties

##### object?

```ts
optional object?: unknown;
```

The parsed object when a plain JSON Schema was passed; absent otherwise.

##### text

```ts
text: string;
```

The generated text. For schema calls, the JSON-stringified object.

***

### InferSchemaOutput

```ts
type InferSchemaOutput<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;
```

The output (validated) type of a Standard Schema.

#### Type Parameters

##### S

`S`

***

### InferToolInput

```ts
type InferToolInput<T extends ToolDef<ToolInputSchema>> = Parameters<T["execute"]>[0];
```

The validated input type a tool's `execute` receives — inferred from the
tool's `inputSchema`. The Vercel AI SDK's `InferToolInput` pattern, so a
client (or another tool) can share the exact argument shape without
re-declaring it.

```ts
import { type InferToolInput, tool } from "@alexkroman1/aai";
import { z } from "zod";

const add = tool({
  description: "Add an item",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }) => item,
});
type AddInput = InferToolInput<typeof add>; // { item: string }
```

#### Type Parameters

##### T

`T` *extends* [`ToolDef`](#tooldef)\<[`ToolInputSchema`](#toolinputschema)\>

***

### InferToolOutput

```ts
type InferToolOutput<T extends ToolDef<ToolInputSchema>> = Awaited<ReturnType<T["execute"]>>;
```

The result type a tool's `execute` returns (awaited, so a sync and an `async`
body infer alike). Pair with `useToolResult<InferToolOutput<typeof myTool>>(...)`
in a custom client so the rendered shape has a single source of truth.

#### Type Parameters

##### T

`T` *extends* [`ToolDef`](#tooldef)\<[`ToolInputSchema`](#toolinputschema)\>

***

### KeyedLock

```ts
type KeyedLock = (key: string, opts?: KeyedLockOptions) => Promise<() => void> & {
  size: number;
};
```

The utilities written INSIDE a tool body — all fifteen of them, which is
`@alexkroman1/aai/utils` minus the five whose reader is not a tool body:
`decodeHtmlEntities` and the four narration formatters (`formatBytes`,
`formatDuration`, `countWords`, `plural`), which a step and a `client.tsx`
both reach for and which are therefore reachable ONLY on that subpath.

**The rule is that the two lists agree for everything else**, because the
split they used to describe was not one anybody could apply: `safeJsonParse` was here and
`isRecord` — the guard you call on what it returns — was not, so a tool body
needing both wrote two import lines for one line of helpers, and templates
routed around it by taking the root's own names off `/utils` instead. That
subpath's membership is a BUILD property (zero-zod, so the CLI can import it
on every invocation), which is a fact about its graph rather than a statement
about who reads it; nothing on it fails this barrel's own membership test.

The narrower subpath stays, because it is what the CLI and the platform
import — and because a tool body reaching for one helper should not have to
name the root. Neither the slug contract nor the framework's wire helpers are
involved either way: those left `sdk/utils.ts` for `@alexkroman1/aai/internal`.

#### Type Declaration

##### size

```ts
readonly size: number;
```

Number of keys currently held or queued. Exposed for tests and metrics.

***

### KeyedLockOptions

```ts
type KeyedLockOptions = {
  timeoutMs?: number;
};
```

The utilities written INSIDE a tool body — all fifteen of them, which is
`@alexkroman1/aai/utils` minus the five whose reader is not a tool body:
`decodeHtmlEntities` and the four narration formatters (`formatBytes`,
`formatDuration`, `countWords`, `plural`), which a step and a `client.tsx`
both reach for and which are therefore reachable ONLY on that subpath.

**The rule is that the two lists agree for everything else**, because the
split they used to describe was not one anybody could apply: `safeJsonParse` was here and
`isRecord` — the guard you call on what it returns — was not, so a tool body
needing both wrote two import lines for one line of helpers, and templates
routed around it by taking the root's own names off `/utils` instead. That
subpath's membership is a BUILD property (zero-zod, so the CLI can import it
on every invocation), which is a fact about its graph rather than a statement
about who reads it; nothing on it fails this barrel's own membership test.

The narrower subpath stays, because it is what the CLI and the platform
import — and because a tool body reaching for one helper should not have to
name the root. Neither the slug contract nor the framework's wire helpers are
involved either way: those left `sdk/utils.ts` for `@alexkroman1/aai/internal`.

#### Properties

##### timeoutMs?

```ts
optional timeoutMs?: number;
```

Give up waiting after this long and reject with
[KeyedLockTimeoutError](#keyedlocktimeouterror). Omit to wait indefinitely.

***

### LlmProvider

```ts
type LlmProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  __stage?: "llm";
};
```

Descriptor for an LLM provider. Returned by factories like
`anthropicLlm(...)` from `@alexkroman1/aai/llm`.

#### Type Declaration

##### \_\_stage?

```ts
readonly optional __stage?: "llm";
```

Compile-time stage tag; never present at runtime.

***

### Message

```ts
type Message = {
  content: string;
  role: "user" | "assistant" | "tool";
};
```

A single message in the conversation history.

Messages are passed to tool `execute` functions via
[ToolContext.messages](#messages) to provide conversation context.

#### Properties

##### content

```ts
content: string;
```

The text content of the message.

##### role

```ts
role: "user" | "assistant" | "tool";
```

The role of the message sender.

***

### PipelineAgentParams

```ts
type PipelineAgentParams = SharedAgentParams & Partial<Pick<AgentDef, Exclude<PipelineOnlyField, SilenceNudgeField>>> & SilenceNudgeParams & {
  llm?: LlmProvider | string;
  page?: "voice" | StaticFrontDoorMisuse;
  s2s?: undefined;
  text?: undefined;
} & 
  | {
  maxTurnSilenceMs?: EndpointingOnDescriptorMisuse<"maxTurnSilenceMs">;
  minTurnSilenceMs?: EndpointingOnDescriptorMisuse<"minTurnSilenceMs">;
  stt: SttProvider;
}
  | {
  maxTurnSilenceMs?: number;
  minTurnSilenceMs?: number;
  stt?: undefined;
} & 
  | {
  tts: TtsProvider;
  voice?: "`voice` picks the default pipeline's TTS voice — an explicit `tts` descriptor owns its own voice (e.g. `assemblyAITts({ voice })`); set it there or remove `tts`";
}
  | {
  tts?: undefined;
  voice?: AssemblyAITtsVoice;
};
```

Pipeline-mode params: any subset of the provider triple (unset stages run
on the default all-AssemblyAI pipeline), never `s2s`. The `voice`
shorthand picks the default pipeline's TTS voice; an explicit `tts`
descriptor owns its voice, so combining the two is a compile error naming
the rule.

#### Type Declaration

##### llm?

```ts
optional llm?: LlmProvider | string;
```

See [AgentDef.llm](#llm); a string is gateway model-id shorthand.
Unset → the default AssemblyAI LLM Gateway model.

##### page?

```ts
optional page?: "voice" | StaticFrontDoorMisuse;
```

See [AgentDef.page](#page). A pipeline agent's front door is a mic.

##### s2s?

```ts
optional s2s?: undefined;
```

##### text?

```ts
optional text?: undefined;
```

#### Remarks

The long string-literal types on the fields below are COMPILE-ERROR MESSAGES,
not values this arm accepts. Setting one of those fields makes `tsc` print the
sentence in place of a bare excess-property error, so the diagnostic names the
rule and what to do about it. Never pass one as a string.

***

### S2sAgentParams

```ts
type S2sAgentParams = SharedAgentParams & {
  llm?: "`llm` cannot be combined with `s2s` — S2S runs the LLM loop service-side";
  maxTurnSilenceMs?: "`maxTurnSilenceMs` tunes a pipeline STT stage — S2S runs STT service-side; remove it or remove `s2s`";
  minTurnSilenceMs?: "`minTurnSilenceMs` tunes a pipeline STT stage — S2S runs STT service-side; remove it or remove `s2s`";
  page?: "voice" | StaticFrontDoorMisuse;
  s2s: S2sProvider;
  stt?: "`stt` cannot be combined with `s2s` — S2S runs STT service-side";
  text?: "`text` cannot be combined with `s2s` — an agent is text-only or speech-to-speech, not both";
  tts?: "`tts` cannot be combined with `s2s` — S2S runs TTS service-side";
  voice?: "`voice` is pipeline-mode only — an S2S agent's voice rides on the `s2s` descriptor";
} & { [K in PipelineOnlyField]?: PipelineOnlyMisuse<K> };
```

S2S-mode params: an `s2s` descriptor, no pipeline providers, and the
pipeline-only tuning knobs typed as `PipelineOnlyMisuse` so setting
one fails with a message instead of silently doing nothing.

#### Type Declaration

##### llm?

```ts
optional llm?: "`llm` cannot be combined with `s2s` — S2S runs the LLM loop service-side";
```

##### maxTurnSilenceMs?

```ts
optional maxTurnSilenceMs?: "`maxTurnSilenceMs` tunes a pipeline STT stage — S2S runs STT service-side; remove it or remove `s2s`";
```

##### minTurnSilenceMs?

```ts
optional minTurnSilenceMs?: "`minTurnSilenceMs` tunes a pipeline STT stage — S2S runs STT service-side; remove it or remove `s2s`";
```

##### page?

```ts
optional page?: "voice" | StaticFrontDoorMisuse;
```

See [AgentDef.page](#page). An S2S agent's front door is a mic.

##### s2s

```ts
s2s: S2sProvider;
```

See [AgentDef.s2s](#s2s) — the explicit opt-in to speech-to-speech mode.

##### stt?

```ts
optional stt?: "`stt` cannot be combined with `s2s` — S2S runs STT service-side";
```

##### text?

```ts
optional text?: "`text` cannot be combined with `s2s` — an agent is text-only or speech-to-speech, not both";
```

##### tts?

```ts
optional tts?: "`tts` cannot be combined with `s2s` — S2S runs TTS service-side";
```

##### voice?

```ts
optional voice?: "`voice` is pipeline-mode only — an S2S agent's voice rides on the `s2s` descriptor";
```

#### Remarks

The long string-literal types on the fields below are COMPILE-ERROR MESSAGES,
not values this arm accepts. Setting one of those fields makes `tsc` print the
sentence in place of a bare excess-property error, so the diagnostic names the
rule and what to do about it. Never pass one as a string.

***

### S2sProvider

```ts
type S2sProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  __stage?: "s2s";
};
```

Descriptor for an S2S provider. Returned by `assemblyAIS2s(...)` (root
export) or `openaiS2s(...)` from `@alexkroman1/aai/s2s`.

#### Type Declaration

##### \_\_stage?

```ts
readonly optional __stage?: "s2s";
```

Compile-time stage tag; never present at runtime.

***

### SessionEventContext

```ts
type SessionEventContext = {
  env: Readonly<Partial<Record<string, string>>>;
  sessionId: string;
  slots: SlotStore;
};
```

What a session event handler is handed alongside the event.

Deliberately much smaller than `ToolContext`, and the omissions are still the
design: there is no `send`, no `generate`, no `delegate` and no `messages`. A
handler MAY NOT SPEAK. Giving it a way to would make the event stream a second
control path into the turn — which is the thing that keeps a log honest, since
anything a reader can change it can no longer describe.

**`slots` is here, and it does not cross that line.** The rule the omissions
enforce is that a handler cannot change the TURN — what the agent says, which
tool runs, whether a reply is cancelled. Maintaining the session's own state is
a different act, and one the alternative made worse: an author who wanted a
fact recorded per turn had no choice but to declare a TOOL for it and instruct
the model to call it, which is a model-cooperation problem standing in for a
bookkeeping one — see `infocom-adventure`, whose `game_state_history` tool
existed to hand the framework back a transcript it already had. A hook writes
the fact directly, on every turn, whether or not the model cooperates.

What a write here still cannot do is be READ by the turn it happened in: the
model sees a slot's value through a tool result, and this runs beside that
path rather than in front of it.

`db` used to be here, because the first thing an audit hook wants is somewhere
to write and the agent already had one. It is gone with `ctx.db`: the platform
provides no database, so a hook that wants to persist brings its own client and
credential — the same change tool code saw, and for the same reason.

#### Properties

##### env

```ts
env: Readonly<Partial<Record<string, string>>>;
```

Environment variables available to this agent (from `.env` under `aai dev`,
`aai secret` in production).

##### sessionId

```ts
sessionId: string;
```

The session this event belongs to — the id a stream read is keyed by.

##### slots

```ts
slots: SlotStore;
```

This session's slot storage — **reach for [sessionSlot](#sessionslot-1), not this**,
exactly as in a tool. It is on the context because a slot declared in one
module has no other way to find the session.

A handler's writes are committed after it returns, so a hook that mutates
should do so SYNCHRONOUSLY. An `await` before `slot.update` still stores the
value, but it lands after the commit for this event and is not persisted
until the next one (or the next tool call) commits — which for a `durable`
slot means a crash in between loses it.

***

### SessionEventHandler

```ts
type SessionEventHandler<E extends SessionEvent = SessionEvent> = (event: E, ctx: SessionEventContext) => unknown;
```

One handler: an event of the type it was declared under, plus the context.

The return type is `unknown`, and that is deliberate rather than lazy.
`void | Promise<void>` reads better and does not compile for the most obvious
handler anyone writes: TypeScript's rule that a value-returning function is
assignable where `void` is expected applies to `void` ALONE, not to a union
containing it — so `(e) => seen.push(e)` (returning `number`) and
`(e) => void persist(…)` are errors, on an observe-only API where the return
value is by definition ignored. `unknown` accepts every shape, and the emitter
checks for a promise at run time to decide whether to attach a rejection
handler.

#### Type Parameters

##### E

`E` *extends* [`SessionEvent`](protocol.md#sessionevent) = [`SessionEvent`](protocol.md#sessionevent)

#### Parameters

##### event

`E`

##### ctx

[`SessionEventContext`](#sessioneventcontext)

#### Returns

`unknown`

***

### SessionEventHandlers

```ts
type SessionEventHandlers = { [K in SessionEventType]?: SessionEventHandler<Extract<SessionEvent, { type: K }>> } & {
  *?: SessionEventHandler;
};
```

The `events` map an agent declares — keyed by event type, plus `"*"`.

The mapped half is what makes a handler's parameter TYPED: declaring
`"tool.called"` hands the handler an event that has `toolName` and `args`,
with no narrowing at the call site. `"*"` receives the whole union, which is
the right shape for the handlers that motivate it (a log line, a metrics
counter) and the reason it cannot be typed more narrowly.

#### Type Declaration

##### \*?

```ts
optional *?: SessionEventHandler;
```

Runs for every event, AFTER the typed handler for that event.

***

### SessionEventType

```ts
type SessionEventType = SessionEvent["type"];
```

Every event name a handler map may be keyed by, as a union.

The keys of [SessionEventHandlers](#sessioneventhandlers) are computed from the wire union, so
without this alias the only way to read the list is the event schema itself —
which renders as one long type expression. Name it to get an autocompletable
union, and to write a handler map's key type down in your own code:

```ts
import type { SessionEventType } from "@alexkroman1/aai";

const AUDITED: readonly SessionEventType[] = ["tool.called", "error.reported"];
```

***

### SharedAgentParams

```ts
type SharedAgentParams = Omit<AgentDef, 
  | DefaultedAgentField
  | PipelineOnlyField
  | ProviderField
  | FrontDoorField> & Partial<Pick<AgentDef, Exclude<DefaultedAgentField, InlineToolsField>>> & {
  tools?: InlineToolsMisuse;
};
```

Fields shared by both session modes: everything on [AgentDef](#agentdef) minus
the providers and the pipeline-only tuning knobs, plus the authoring
conveniences.

#### Type Declaration

##### tools?

```ts
optional tools?: InlineToolsMisuse;
```

Not a field. See `InlineToolsMisuse` — a tool is declared by its
FILE, so this is typed as the message that names the one to create.

***

### SleepOptions

```ts
type SleepOptions = {
  correlationId?: string;
};
```

Per-sleep options.

#### Properties

##### correlationId?

```ts
optional correlationId?: string;
```

A name for this wait, so it can be ended early by name.

Not required, and the default is deliberately the broad one: a `wake` naming
no ids ends every outstanding wait on the run. An id is what lets a run with
two concurrent waits — a review window and a retry backoff — have one of them
cut short without the other.

***

### SlotHolder

```ts
type SlotHolder = {
  sessionId: string;
  slots: SlotStore;
};
```

Anything that can reach one session's slots.

Every [SessionSlot](#sessionslot) and [Dialog](#dialog) method takes this rather than a
full [ToolContext](#toolcontext), and the widening is the whole reason a session event
handler can maintain state: these two fields are ALL any of them ever read, so
requiring the other eight was a statement that slots are a tool-only
capability — which stopped being true when [SessionEventContext](#sessioneventcontext) grew
one.

Both a `ToolContext` and a [SessionEventContext](#sessioneventcontext) satisfy it
structurally, so no existing call site changed.

#### Properties

##### sessionId

```ts
readonly sessionId: string;
```

Which session. Not reachable from [SlotStore](#slotstore), which is already scoped
to one — a slot needs the id to key its open-draft guard, the check that
refuses a `set`/`reset`/`update` issued from inside another `update`'s
mutator.

##### slots

```ts
readonly slots: SlotStore;
```

This session's slot storage.

***

### SlotStore

```ts
type SlotStore = {
  read: unknown;
  write: void;
};
```

One session's slot storage, as a tool's context carries it.

Two methods and no index signature, which is the point: it replaced
`ctx.state`, a field typed `any` whose entire justification was that the bag
it held was dynamic. A slot's value is typed by its own `sessionSlot<T>`,
which is stronger than the annotation authors used to be told to write, and
there is no longer a bag to cast.

**Reach for [sessionSlot](#sessionslot-1) rather than this.** It is on the context
because a slot lives in a module that has no other way to find the session,
not because a tool body should call it.

#### Methods

##### read()

```ts
read(key: string): unknown;
```

This session's value for `key`, or `undefined` when the slot has never
been written (a fresh session, or one whose stored value was discarded).

The returned object is FROZEN — see `freezeStorable` in this module.

###### Parameters

###### key

`string`

###### Returns

`unknown`

##### write()

```ts
write(
   key: string, 
   value: unknown, 
   durable: boolean
): void;
```

Store this session's value for `key`.

`durable` is the slot's own declaration. A durable value is checked and
frozen here and committed to the backend at the end of the tool call; a
virtual one is neither, because the things a virtual slot exists to hold
(a provider handle, an open socket) can be neither serialized nor frozen.

###### Parameters

###### key

`string`

###### value

`unknown`

###### durable

`boolean`

###### Returns

`void`

***

### StaticAgentParams

```ts
type StaticAgentParams = Omit<StaticAgentParamsCore, WorkflowAppOnlyField> & { [K in WorkflowAppOnlyField]?: WorkflowAppMisuse<K> };
```

Workflow-app params: `page: "static"`, the workflows that ARE the product,
and nothing from the session half of the agent shape.

Not a session mode like the other three arms — a front door. What it drops is
everything downstream of having a session at all.

What it keeps is the surface a page and a deploy actually read: `name` and
`greeting` (both served by `GET /client-config`, so a page can render its
shell from the agent — `page()` does not fetch it the way `client()` does, so
a page that wants them calls `fetchClientConfig()` itself), `workflows`, and
`requiredEnv` (a step reads keys with `stepEnv` from
`@alexkroman1/aai/step`, and a deploy still checks they are present).

`workflows` is REQUIRED here, unlike on [AgentDef](#agentdef): a workflow app whose
whole API is `/workflows/*` and which declares none serves a form with nothing
behind it, and the page's `api.start(name, …)` would 400 on every submit.

#### Remarks

The long string-literal types on the fields below are COMPILE-ERROR MESSAGES,
not values this arm accepts. Setting one of those fields makes `tsc` print the
sentence in place of a bare excess-property error, so the diagnostic names the
rule and what to do about it. Never pass one as a string.

***

### StepOptions

```ts
type StepOptions<S extends StandardSchemaV1 = StandardSchemaV1> = {
  maxAttempts?: number;
  schema?: S;
};
```

Per-step overrides. Everything here has a default that is right for most
steps; passing nothing is the common case.

#### Type Parameters

##### S

`S` *extends* `StandardSchemaV1` = `StandardSchemaV1`

The schema [StepOptions.schema](#schema-1) carries, when one is
  given. Defaulted, so `StepOptions` is still spellable without an argument —
  every caller that predates the schema still means what it meant.

#### Properties

##### maxAttempts?

```ts
optional maxAttempts?: number;
```

How many times to run this step before the run fails, counting the first
attempt.

Only a `RetryableError` (or an unclassified throw) consumes an attempt — a
`FatalError` fails the run on the spot, which is the point of the
distinction. See `@alexkroman1/aai/step-errors`.

Defaults to [DEFAULT\_STEP\_MAX\_ATTEMPTS](#default_step_max_attempts). It is a per-step number
rather than a global because the right answer is a property of what the
step DOES: a model call worth retrying three times and a payment capture
worth retrying never are both ordinary.

##### schema?

```ts
optional schema?: S;
```

The shape this step's output must have — any
[Standard Schema](https://standardschema.dev), zod being the documented
default. Its OUTPUT type is what the step resolves to.

**Checked on BOTH sides of the journal, and the two catch different bugs.**
On the WRITE, before the entry is appended, so a body that produced the
wrong shape — or a value the journal's codec cannot carry — fails at the
step that produced it rather than on a replay days later; that failure is
the step's own, so it spends an attempt and a retry may well fix it. On the
READ, when a later walk is answered from the journal, which is what catches
a REDEPLOY mid-flight: the run resumes against a bundle whose step returns a
different shape, and without this the body is handed the old one under the
new type. That failure is NOT the step's — the step succeeded, days ago —
so it fails the run the way a divergence does and journals nothing.

Durable session state has been checked structurally in both backends for a
long time (`packages/aai/CLAUDE.md`, "A slot OWNS its session state": `Map`
→ `{}`, `Date` → string, `NaN` → null — the values that corrupt do not
throw, so `JSON.stringify` is not the check). A step's output is exactly as
durable and had no check at all.

A schema that COERCES is supported and often the better answer: what is
journaled is what the schema passed, never the raw value, so the next walk
reads the same thing this one was handed.

***

### StepSchemaOptions

```ts
type StepSchemaOptions<S extends StandardSchemaV1 = StandardSchemaV1> = StepOptions<S> & {
  schema: S;
};
```

[StepOptions](#stepoptions) with the schema PRESENT — what selects the validating
overload of `ctx.step`, whose result is the schema's output rather than
whatever the body happened to return.

#### Type Declaration

##### schema

```ts
schema: S;
```

The shape — see [StepOptions.schema](#schema-1).

#### Type Parameters

##### S

`S` *extends* `StandardSchemaV1` = `StandardSchemaV1`

***

### SttProvider

```ts
type SttProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  __stage?: "stt";
};
```

Descriptor for an STT provider. Returned by factories like
`assemblyAIStt(...)` from `@alexkroman1/aai/stt`.

#### Type Declaration

##### \_\_stage?

```ts
readonly optional __stage?: "stt";
```

Compile-time stage tag; never present at runtime.

***

### TextAgentParams

```ts
type TextAgentParams = Omit<SharedAgentParams, "sttPrompt"> & {
  llm?: LlmProvider | string;
  maxTurnSilenceMs?: "`maxTurnSilenceMs` tunes an STT stage — a text agent has none; remove it or remove `text`";
  minTurnSilenceMs?: "`minTurnSilenceMs` tunes an STT stage — a text agent has none; remove it or remove `text`";
  page?: "voice" | StaticFrontDoorMisuse;
  s2s?: "`s2s` cannot be combined with `text` — an agent is text-only or speech-to-speech, not both";
  stt?: "`stt` cannot be combined with `text` — a text agent has no audio to transcribe";
  sttPrompt?: "`sttPrompt` biases a transcriber — a text agent has none; remove it or remove `text`";
  text: true;
  tts?: "`tts` cannot be combined with `text` — a text agent has no audio to synthesize";
  voice?: "`voice` is pipeline-mode only — a text agent never speaks";
} & { [K in PipelineOnlyField]?: PipelineOnlyMisuse<K, "text"> };
```

Text-mode params: `text: true`, optionally an `llm`, and nothing else from
the audio half of the agent shape.

Every speech field is typed as a message rather than left absent, on the
same reasoning as [S2sAgentParams](#s2sagentparams): a bare excess-property error
names the field and not the rule, and the rule here ("a text agent has no
audio path") is exactly what an author moving a voice agent to text needs
told. `sttPrompt` is included even though it is otherwise mode-agnostic —
it biases a transcriber, and there is none.

The pipeline-only voice knobs are derived from `PipelineOnlyField`,
so a knob added to [PipelineVoiceTuning](#pipelinevoicetuning) is rejected here for free.

#### Type Declaration

##### llm?

```ts
optional llm?: LlmProvider | string;
```

See [AgentDef.llm](#llm); a string is gateway model-id shorthand. Unset →
the default AssemblyAI LLM Gateway model. The one provider stage a text
agent has.

##### maxTurnSilenceMs?

```ts
optional maxTurnSilenceMs?: "`maxTurnSilenceMs` tunes an STT stage — a text agent has none; remove it or remove `text`";
```

##### minTurnSilenceMs?

```ts
optional minTurnSilenceMs?: "`minTurnSilenceMs` tunes an STT stage — a text agent has none; remove it or remove `text`";
```

##### page?

```ts
optional page?: "voice" | StaticFrontDoorMisuse;
```

See [AgentDef.page](#page). A text agent has no browser front door of its
own — it is driven by `createTextAgent`, not by a page.

##### s2s?

```ts
optional s2s?: "`s2s` cannot be combined with `text` — an agent is text-only or speech-to-speech, not both";
```

##### stt?

```ts
optional stt?: "`stt` cannot be combined with `text` — a text agent has no audio to transcribe";
```

##### sttPrompt?

```ts
optional sttPrompt?: "`sttPrompt` biases a transcriber — a text agent has none; remove it or remove `text`";
```

##### text

```ts
text: true;
```

See [AgentDef.text](#text) — the explicit opt-in to text mode.

##### tts?

```ts
optional tts?: "`tts` cannot be combined with `text` — a text agent has no audio to synthesize";
```

##### voice?

```ts
optional voice?: "`voice` is pipeline-mode only — a text agent never speaks";
```

#### Remarks

The long string-literal types on the fields below are COMPILE-ERROR MESSAGES,
not values this arm accepts. Setting one of those fields makes `tsc` print the
sentence in place of a bare excess-property error, so the diagnostic names the
rule and what to do about it. Never pass one as a string.

***

### ToolChoice

```ts
type ToolChoice = 
  | "auto"
  | "required"
  | "none"
  | {
  toolName: string;
  type: "tool";
};
```

How the LLM should select tools during a turn. Mirrors the Vercel AI
SDK's `toolChoice`.

- `"auto"` — The model decides whether to call a tool (default).
- `"required"` — The model must call at least one tool each step.
- `"none"` — The model may not call tools this session.
- `{ type: "tool", toolName }` — The model must call the named tool.

***

### ToolContext

```ts
type ToolContext = {
  delegate: DelegateFn;
  env: Readonly<Partial<Record<string, string>>>;
  generate: GenerateFn;
  messages: readonly Message[];
  sessionId: string;
  signal: AbortSignal;
  slots: SlotStore;
  workflows: WorkflowClient;
  send: void;
};
```

Context passed to tool `execute` functions.

Provides access to the session environment, state, database, and
conversation history from within a tool's execute handler.

#### Remarks

It takes no type parameter. It used to take the agent's state shape, because
`ctx.state` was a bag whose type a tool could only learn from an annotated
context — so every module in a multi-file agent either restated the
annotation or cast. [sessionSlot](#sessionslot-1) is the whole of that job now: a
slot's value is typed by the slot, in the one module that declares it.

#### Example

```ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

const lookupNote = tool({
  description: "Look up a note",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }, ctx) => {
    // `ctx.env` for a credential, and whatever client the author brought —
    // there is no `ctx.db`, because the platform hands tool code no database.
    const res = await fetch(`${ctx.env.NOTES_API}/notes/${id}`);
    return { id, note: res.ok ? await res.json() : null };
  },
});
```

#### Methods

##### send()

```ts
send(event: string, data: unknown): void;
```

Push a custom event to the connected browser client. Fire-and-forget:
events whose name exceeds `MAX_CLIENT_EVENT_NAME_LENGTH` or whose
serialized payload exceeds `MAX_CLIENT_EVENT_PAYLOAD_BYTES` are
dropped (with a warning log), not thrown.

###### Parameters

###### event

`string`

###### data

`unknown`

###### Returns

`void`

#### Properties

##### delegate

```ts
delegate: DelegateFn;
```

Hand a bounded task to a SUBAGENT — a second tool loop with its own
instructions, model, tools and context window — and get back what it
concluded, not how it got there ([DelegateFn](#delegatefn)).

The sibling of [ToolContext.generate](#generate), and the line between them is
how many model turns the answer takes: `generate` is one prompt, `delegate`
is a loop whose intermediate tool results the caller has no reason to
carry. Executes on the host wherever the runtime runs, like `generate`.

**A subagent's own tools cannot delegate further** — their `ctx.delegate`
rejects naming the reason. One level is a bill a caller can quote; a
subagent that may delegate can delegate to itself, and nothing at this
seam can see the recursion.

###### Remarks

The TENTH field on this type, and the one that raised `guard-invariants`
rule 24 from nine. Recorded here because that is where a baselined
occurrence's reason belongs: a field on this type is a capability the
runtime must supply on EVERY tool call, on every host, in every test
double — so it is a promise, not a convenience, and the rule exists to make
adding one an argued decision rather than a diff nobody reads.

The argument for this one is that it passes the test the rule sets: it is
per-CALL and it cannot be reached any other way. A tool body cannot build a
subagent runner itself — resolving the model, the builtins, the step budget
and the nesting refusal are all the host's, exactly as they are for
`generate`. Anything reachable from a value the author already holds is not
this, and belongs in that value's own module.

##### env

```ts
env: Readonly<Partial<Record<string, string>>>;
```

Environment variables available to this agent's tools (from `.env` under
`aai dev`, `aai secret` in production). Custom keys a tool depends on
should be declared in [AgentDef.requiredEnv](#requiredenv) so a missing value
fails at deploy time.

**`Partial`, so every read is `string | undefined`.** A variable that was
never set is `undefined` at runtime whatever the type says, and the type
used to say `string`: `ctx.env.NEVER_DECLARED` type-checked, built green,
and threw a `TypeError` on the first live call — which `tool-executor.ts`
then hands to the MODEL, so the caller hears the agent improvise an
apology. `noUncheckedIndexedAccess` says the same thing, but it is the
AUTHOR's tsconfig and cannot be relied on from here.

Reach for [requireEnv](#requireenv) rather than a `??` at each site — it throws
a sentence naming the variable and pointing at `requiredEnv`.

##### generate

```ts
generate: GenerateFn;
```

One-shot LLM generation, executed on the host.
Defaults to the agent's pipeline `llm`; pass `llm` in the options to use
another provider (its API key must be in the agent's env). Throws when
no LLM is configured or named. Pass a Zod `schema` for typed structured
output ([GenerateFn](#generatefn)).

##### messages

```ts
messages: readonly Message[];
```

Read-only snapshot of conversation messages so far.

##### sessionId

```ts
sessionId: string;
```

Unique identifier for the current session. Useful for correlating logs across concurrent sessions.

##### signal

```ts
signal: AbortSignal;
```

Cooperative cancellation signal. Aborts when the turn that issued this
tool call is cancelled (barge-in, reset, or session stop), and also when
the call itself settles exceptionally — above all on timeout. Long-running
tools should pass it to `fetch` etc. so their work stops promptly.

###### Remarks

Always present. It was optional until it was checked: the executor builds
a per-call `AbortController` on every path and there has never been a
context without one, so the `?` only bought authors a `?.` on every
`ctx.signal.aborted` and a `!` wherever a non-optional `AbortSignal` was
wanted. A context that genuinely cannot cancel supplies a signal that
never aborts rather than omitting the field.

##### slots

```ts
slots: SlotStore;
```

This session's slot storage. **Reach for [sessionSlot](#sessionslot-1), not this** —
it is on the context because a slot declared in one module has no other way
to find the session, not because a tool body should call it.

It replaced `ctx.state`, a field typed `any` whose whole justification was
that the bag it held was dynamic. There is no bag: a slot owns its value,
types it, and is the only thing that writes it.

##### workflows

```ts
workflows: WorkflowClient;
```

Start and inspect durable workflow runs — the way a tool hands off work that
must outlive the call.

A voice tool cannot do slow work inline: the caller is on the line. So it
starts a run and answers in the same turn ("I've kicked that off, I'll text
you"), and the run continues on the queue after the session ends. Pass
`{ key: ctx.sessionId }` so a later turn — or a later CALL — can find it
again; see `StartOptions.key` (`@alexkroman1/aai/workflow-api`).

Every method rejects when the app declares no workflows or has no workflow
backend configured, naming which.

***

### ToolDef

```ts
type ToolDef<P extends ToolInputSchema = ToolInputSchema, R = unknown> = {
  description: string;
  inputSchema?: P;
  execute: R;
};
```

Definition of a custom tool that the agent can invoke.

Tools are the primary way to extend agent capabilities. Each tool has a
description (shown to the LLM), an optional input schema, and an
`execute` function that runs inside the sandboxed worker.

#### Example

```ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

const weatherTool = tool({
  description: "Get current weather for a city",
  inputSchema: z.object({
    city: z.string().describe("City name"),
  }),
  execute: async ({ city }) => {
    const res = await fetch(`https://wttr.in/${city}?format=j1`);
    return await res.json();
  },
});
```

#### Type Parameters

##### P

`P` *extends* [`ToolInputSchema`](#toolinputschema) = [`ToolInputSchema`](#toolinputschema)

The tool's input schema: any
  [Standard Schema](https://standardschema.dev) that can convert to JSON
  Schema — a Zod object schema (the documented default) or e.g. an
  ArkType type. Defaults to a permissive record schema so tools without
  inputs don't need an explicit type argument.

##### R

`R` = `unknown`

What `execute` returns, inferred at the [tool](#tool-2) call and
  read by [InferToolOutput](#infertooloutput). Defaults to `unknown`, so `ToolDef<typeof
  schema>` still means "any result".

#### Methods

##### execute()

```ts
execute(args: InferSchemaOutput<P>, ctx: ToolContext): R;
```

Function that executes the tool and returns a result. The result is
JSON-serialized for the LLM and the client, and capped at
`MAX_TOOL_RESULT_CHARS` (4000) characters — longer results are
trimmed and end with a `[truncated]` marker.

###### Parameters

###### args

[`InferSchemaOutput`](#inferschemaoutput)\<`P`\>

###### ctx

[`ToolContext`](#toolcontext)

###### Returns

`R`

#### Properties

##### description

```ts
description: string;
```

Human-readable description shown to the LLM.

##### inputSchema?

```ts
optional inputSchema?: P;
```

Schema for the tool's input, shown to the LLM and used to validate each
call's arguments before `execute` runs. Named after the Vercel AI SDK's
`tool({ inputSchema })`.

***

### ToolInputSchema

```ts
type ToolInputSchema = StandardSchemaV1<unknown, Record<string, unknown>>;
```

A schema accepted for tool inputs and `ctx.generate` structured output:
any Standard Schema that can also convert to JSON Schema (Zod natively,
or a vendor `toJsonSchema()` method). Zod object schemas are the
documented default.

***

### TtsProvider

```ts
type TtsProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  __stage?: "tts";
};
```

Descriptor for a TTS provider. Returned by factories like
`cartesiaTts(...)` from `@alexkroman1/aai/tts`.

#### Type Declaration

##### \_\_stage?

```ts
readonly optional __stage?: "tts";
```

Compile-time stage tag; never present at runtime.

***

### WaitForOptions

```ts
type WaitForOptions<S extends StandardSchemaV1 = StandardSchemaV1> = {
  schema?: S;
  timeoutMs: number;
};
```

Per-wait options, for a wait that carries a DEADLINE.

A wait that carries only a schema takes [WaitForSchemaOptions](#waitforschemaoptions) instead —
two types rather than one optional `timeoutMs`, because the deadline is what
decides whether the call can resolve `undefined`, and a single bag with both
halves optional would put `| undefined` on the result of a wait that has no
way to end unanswered.

#### Type Parameters

##### S

`S` *extends* `StandardSchemaV1` = `StandardSchemaV1`

#### Properties

##### schema?

```ts
optional schema?: S;
```

The shape the payload must have — any
[Standard Schema](https://standardschema.dev), zod being the documented
default. Its OUTPUT type is what the wait resolves to, in place of the type
parameter.

**A payload is UNTRUSTED**: it arrives over public HTTP, through
`ctx.workflows.signal` or a webhook delivery to
`ctx.workflows.publicWebhookUrl(token)`, and nothing between the sender and
the body inspects it. The type parameter says what you EXPECT; this is the
only thing that checks. `stepGenerateJson` on `@alexkroman1/aai/step` makes
the same trade against a model's reply, and its module doc carries the
general argument under "Why a schema rather than a type parameter".

A payload that fails is a FATAL failure of the run rather than a retry or an
`undefined`: the payload is journaled, so every later delivery reads the
same bytes and refuses identically — there is nothing a redelivery could
change.

**Validation runs AFTER the window has been decided, and does not un-decide
it.** Whether this wait was answered or timed out is settled by a
compare-and-set on the hook before the body continues (`closeHook`) — that
ordering is what stops a signal landing a moment later from making the next
replay answer a window this one timed out — so by the time a payload is
checked, the delivery has already happened and been recorded. A rejected
payload therefore leaves the hook exactly as it found it: DELIVERED, not
reopened. Reopening would be worse in both directions — it would invite a
second signal to overwrite the first, and it would make the run's history
disagree with the request the sender was answered on. Nobody sent the wrong
shape twice by accident, and the run failing loudly is the outcome that gets
it fixed.

`timeoutMs` elapsing unanswered is NOT a validation failure: there is no
payload, the wait resolves `undefined`, and the schema is never consulted.

A schema that coerces or strips unknown keys is supported and is usually
what a webhook wants; the validated value is what the body receives.

```ts
import type { WorkflowCtx } from "@alexkroman1/aai";
import { z } from "zod";

// Derived from the run's own input, so the tool handing the URL out and the
// body waiting on it agree — see `WorkflowCtx.waitFor`.
declare function approvalToken(id: string): string;

export async function reviewFlow(input: { id: string }, ctx: WorkflowCtx) {
  const approval = await ctx.waitFor(approvalToken(input.id), {
    schema: z.object({ approved: z.boolean() }),
    timeoutMs: 24 * 60 * 60 * 1000,
  });
  if (approval === undefined) return { published: false, reason: "expired" };
  return { published: approval.approved };
}
```

##### timeoutMs

```ts
timeoutMs: number;
```

How long to wait before giving up, in milliseconds.

Resolves `undefined` when it elapses unanswered — not a throw, because a
window closing is an ordinary outcome a body branches on rather than a
failure. A signal that arrives after it is answered `false`, so a caller
cannot be told their answer was taken when it was not.

***

### WaitForSchemaOptions

```ts
type WaitForSchemaOptions<S extends StandardSchemaV1 = StandardSchemaV1> = {
  schema: S;
};
```

A wait that carries a schema and NO deadline — `ctx.waitFor(token, { schema })`.

Its own type rather than an optional `timeoutMs` on [WaitForOptions](#waitforoptions),
for the reason stated there: an unbounded wait has no unanswered branch, so
its result must not carry `| undefined`.

#### Type Parameters

##### S

`S` *extends* `StandardSchemaV1` = `StandardSchemaV1`

#### Properties

##### schema

```ts
schema: S;
```

The shape the payload must have — see [WaitForOptions.schema](#schema-2).

***

### WorkflowClient

```ts
type WorkflowClient = {
  cancel: Promise<boolean>;
  find: Promise<WorkflowRunSnapshot<R>[]>;
  get: Promise<
     | WorkflowRunSnapshot<R>
    | undefined>;
  lastLine: Promise<unknown>;
  listing: WorkflowSummary[];
  publicWebhookUrl: string;
  recent: Promise<WorkflowRunSnapshot<R>[]>;
  signal: Promise<boolean>;
  start: Promise<string>;
  stream: Promise<ReadableStream<unknown>>;
  streamTail: Promise<number>;
  wakeUp: Promise<number>;
};
```

Start and inspect workflow runs. Reaches tool code as `ctx.workflows`.

**Prefer passing the workflow itself over its name.** Every method here is
overloaded on `WorkflowDef | string`, and the def overload is the one that
types the input against the workflow's own schema, types `output` against its
return, and turns a misspelled workflow into a compile error instead of a
promise rejection the model reads as a tool failure. The string overload stays
for a name that genuinely is data — read from config, a database, a request.

The def is resolved to its declared name by IDENTITY against
`agent({ workflows })`, so that record stays the single source of the name,
and to its `workflowId` through its own `run` function.

#### Methods

##### cancel()

```ts
cancel(runId: string): Promise<boolean>;
```

Stop a run. Resolves true when this call is what ended it, false when it
was already terminal (or no such run exists).

A cancelled run is terminal: it is never resumed, and its event log is kept
so what it did before stopping stays readable.

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<`boolean`\>

##### find()

###### Call Signature

```ts
find<P extends ToolInputSchema, R>(
   workflow: WorkflowDef<P, R>, 
   key: string, 
   options?: FindOptions
): Promise<WorkflowRunSnapshot<R>[]>;
```

Runs of `workflow` started with this correlation key, newest first.

The read half of [StartOptions.key](workflow-api.md#key) — see there for why a voice agent
needs it. Resolves an empty array when nothing matches.

###### Type Parameters

###### P

`P` *extends* [`ToolInputSchema`](#toolinputschema)

###### R

`R`

###### Parameters

###### workflow

[`WorkflowDef`](#workflowdef)\<`P`, `R`\>

###### key

`string`

###### options?

[`FindOptions`](workflow-api.md#findoptions)

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](workflow-api.md#workflowrunsnapshot)\<`R`\>[]\>

###### Call Signature

```ts
find(
   workflow: string, 
   key: string, 
   options?: FindOptions
): Promise<WorkflowRunSnapshot[]>;
```

###### Parameters

###### workflow

`string`

###### key

`string`

###### options?

[`FindOptions`](workflow-api.md#findoptions)

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](workflow-api.md#workflowrunsnapshot)[]\>

##### get()

###### Call Signature

```ts
get<R>(runId: string, of: AnyWorkflowDef<R>): Promise<
  | WorkflowRunSnapshot<R>
| undefined>;
```

Look up a run by id. Resolves `undefined` when no such run exists.

Pass the workflow as the second argument to type `output` on a completed
run; with the id alone there is nothing to infer it from, so it is
`unknown`. The argument is used ONLY for that — the run's own record says
which workflow it belongs to.

###### Type Parameters

###### R

`R`

###### Parameters

###### runId

`string`

###### of

[`AnyWorkflowDef`](workflow-api.md#anyworkflowdef)\<`R`\>

###### Returns

`Promise`\<
  \| [`WorkflowRunSnapshot`](workflow-api.md#workflowrunsnapshot)\<`R`\>
  \| `undefined`\>

###### Call Signature

```ts
get(runId: string): Promise<
  | WorkflowRunSnapshot
| undefined>;
```

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<
  \| [`WorkflowRunSnapshot`](workflow-api.md#workflowrunsnapshot)
  \| `undefined`\>

##### lastLine()

```ts
lastLine(runId: string, options?: StreamOptions): Promise<unknown>;
```

The NEWEST chunk a run has written, or `undefined` when it has written
nothing.

**Reach for this instead of composing [streamTail](#streamtail) and
[stream](#stream) — the composition is the one a tool gets wrong, and getting
it wrong HANGS.** A progress channel is never closed (no step knows it is
the last one), so `stream` on a run with nothing in it yields nothing and
waits forever rather than ending: a voice agent's tool call stops mid-turn
with no error, no timeout of its own, and nothing in a log to read. The
bound that prevents it is `streamTail() < 0`, which has to come FIRST and
is not an optimization. Two templates carried the same six-line comment
saying exactly that, above the same eight lines, which is what a missing
front door looks like.

This method cannot hang: it asks for the tail before it opens anything, and
it opens a stream only once the tail says there is a chunk to read. It
reads ONE chunk and cancels, so nothing is left draining behind it.

The chunk is `unknown` — whatever the body passed to `getWritable()`, which
this SDK does not constrain. A tool narrating progress wants
`String(line)`; a body writing structured records should narrow with a
guard.

[streamTail](#streamtail) and [stream](#stream) stay public and are still the right
pair for reading a WHOLE log — a page rendering every line, a reader
resuming from where it got to. This is only the "read me the newest thing"
case, which is the one with a trap in it.

`options.namespace` selects the stream, as everywhere else. A non-negative
`options.startIndex` acts as a FLOOR: nothing is resolved until the run has
written that far, which is what a reader that has already seen up to an
index wants. A negative one asks for the newest chunk, which is what this
returns anyway.

###### Parameters

###### runId

`string`

###### options?

[`StreamOptions`](workflow-api.md#streamoptions)

###### Returns

`Promise`\<`unknown`\>

##### listing()

```ts
listing(): WorkflowSummary[];
```

The workflows this agent declares, name + description + input schema.

Synchronous, and on the CLIENT rather than only on the engine, because tool
code is a legitimate reader: the `workflow_status` builtin has to ask about
every declared workflow when the model named none, and nothing else in
`ToolContext` could tell it what those are. Empty when no backend is
available, which is the same answer as "this app declares none".

###### Returns

[`WorkflowSummary`](workflow-api.md#workflowsummary)[]

##### publicWebhookUrl()

```ts
publicWebhookUrl(token: string): string;
```

The PUBLIC URL a third party delivers a webhook to, for a hook holding
`token` — this agent's configured public base URL plus the DevKit's webhook
route.

**Not `hook.url`, and that is the whole reason it exists**: the DevKit
composes its own from `getWorkflowMetadata().url`, which is
`http://localhost:<port>` off the running process — the inside of a container
that has self-exited by the time the callback comes. Treat `hook.url` as
guest-local and use this for anything leaving the system.

Synchronous, and it THROWS when no public URL is configured, naming the
option. The token is the CALLER's, exactly as [signal](#signal-2) takes it. See
"A callback URL comes from `publicWebhookUrl`" in `packages/aai/CLAUDE.md`.

###### Parameters

###### token

`string`

###### Returns

`string`

##### recent()

###### Call Signature

```ts
recent<P extends ToolInputSchema, R>(workflow: WorkflowDef<P, R>, options?: FindOptions): Promise<WorkflowRunSnapshot<R>[]>;
```

Runs of `workflow`, newest first, whatever key they carry.

The OPERATOR's read where [find](#find) is the agent's. A console — the
studio's Settings pane, a `curl` — asking "what has this workflow been doing"
holds no correlation key, and most runs carry none at all: a page keeps its
own `runId`, so only a voice agent's runs are keyed.

Deliberately its own method rather than `find` with an optional key, because
a keyless lookup is not a lookup that matched every key. Sharing one method
would let a caller meaning "this session's runs" read every session's the
moment its key went `undefined` — a scoping bug with no symptom.

###### Type Parameters

###### P

`P` *extends* [`ToolInputSchema`](#toolinputschema)

###### R

`R`

###### Parameters

###### workflow

[`WorkflowDef`](#workflowdef)\<`P`, `R`\>

###### options?

[`FindOptions`](workflow-api.md#findoptions)

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](workflow-api.md#workflowrunsnapshot)\<`R`\>[]\>

###### Call Signature

```ts
recent(workflow: string, options?: FindOptions): Promise<WorkflowRunSnapshot[]>;
```

###### Parameters

###### workflow

`string`

###### options?

[`FindOptions`](workflow-api.md#findoptions)

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](workflow-api.md#workflowrunsnapshot)[]\>

##### signal()

```ts
signal(token: string, payload?: unknown): Promise<boolean>;
```

Deliver a payload to a run parked on `createHook({ token })`, resuming it.
Resolves true when a hook was listening on `token`, false when none was.

**This is the half of the mechanism a voice agent needs and could not
reach.** A run that has to WAIT for a person — an approval, a choice, a
"yes, go ahead" — parks on a hook, and until now the only way to feed one
was the public webhook URL `createWebhook()` mints, which is for a third
party with a callback to make. The caller on the phone is neither: they are
right here, mid-turn, and the thing that should resume the run is a tool.

[wakeUp](#wakeup) is not this. It ends a pending `sleep()`, which is a run
waiting for TIME; a hook is a run waiting for an ANSWER, and the answer is
the payload. A body that raced a hook against a `sleep` — the shape a
decision-with-a-deadline takes — needs both, and they mean different things.

**The token is the contract, and it has to be derivable on both sides.** A
hook's token is chosen by the BODY and typed in by the tool, so it must be
something each can compute from what it already has:
`` `retention:${input.requestedBy}` `` in the body against
`` `retention:${ctx.sessionId}` `` in the tool. Put that expression in one
exported helper both import, rather than writing the template literal twice.

Two properties come with it. A token is claimed by ONE live hook, so two
runs that would derive the same token collide — the body detects that with
`hook.getConflict()`, and the ordinary fix is the one a voice agent wants
anyway: at most one live run per caller. And a token is a capability: it
addresses a run, so derive it from something session-scoped rather than from
anything a caller could name.

**`false` is an answer.** Nobody listening is the normal case, not a
failure — the run has moved past its hook, or finished, or was never
started. Same shape as
[cancel](#cancel) resolving false and [wakeUp](#wakeup) resolving `0`, and a voice
tool should say so out loud ("that one had already gone ahead") rather than
treat it as an error.

###### Parameters

###### token

`string`

###### payload?

`unknown`

###### Returns

`Promise`\<`boolean`\>

##### start()

###### Call Signature

```ts
start<P extends ToolInputSchema, R>(
   workflow: WorkflowDef<P, R>, 
   input: InferSchemaOutput<P>, 
   options?: StartOptions
): Promise<string>;
```

Create a run and return its id without waiting for it to finish — the
point of the whole mechanism. A tool that calls this answers the caller
in the same turn ("started, I'll text you") while the run continues past
the end of the session.

Rejects when the workflow is not declared on this agent, when the input
fails its schema, or when no workflow backend is configured.

###### Type Parameters

###### P

`P` *extends* [`ToolInputSchema`](#toolinputschema)

###### R

`R`

###### Parameters

###### workflow

[`WorkflowDef`](#workflowdef)\<`P`, `R`\>

###### input

[`InferSchemaOutput`](#inferschemaoutput)\<`P`\>

Required for the definition form, even for a workflow that declares no
schema — pass `{}` there. Optional would mean a schema-CARRYING workflow
could be started with no input by omission, which is the mistake this
overload exists to catch; `{}` is a small cost for that.

###### options?

[`StartOptions`](workflow-api.md#startoptions)

###### Returns

`Promise`\<`string`\>

###### Call Signature

```ts
start(
   workflow: string, 
   input?: unknown, 
   options?: StartOptions
): Promise<string>;
```

###### Parameters

###### workflow

`string`

###### input?

`unknown`

###### options?

[`StartOptions`](workflow-api.md#startoptions)

###### Returns

`Promise`\<`string`\>

##### stream()

```ts
stream(runId: string, options?: StreamOptions): Promise<ReadableStream<unknown>>;
```

Read what a run has WRITTEN while running, as a stream.

The gap this fills: a snapshot carries a status and, once terminal, an
output — so a run that takes ten minutes is `running` for ten minutes and
then done, with nothing in between. A workflow that wants to report progress
writes to `getWritable()` (imported from `workflow`, like `sleep`), and this
is the read side.

Chunks are RETAINED with the run, not live-only, so this is equally a replay:
a page that reloads mid-run reads the whole stream from the start by default,
and `startIndex` is for a reader that knows where it got to.

The stream is lazy — a run that does not exist surfaces when it is read, not
here — so a caller wanting a clean "no such run" answer should [get](#get-1) it
first, which is what the HTTP route does.

###### Parameters

###### runId

`string`

###### options?

[`StreamOptions`](workflow-api.md#streamoptions)

###### Returns

`Promise`\<`ReadableStream`\<`unknown`\>\>

##### streamTail()

```ts
streamTail(runId: string, options?: StreamOptions): Promise<number>;
```

How far the run's stream currently goes: the index of the last chunk
written, or `-1` for a stream nothing has written to.

**This is what makes reading a progress stream terminate.** A workflow stream
reports its end only once it has been CLOSED, and a progress channel written
by one step after another is never closed — no step knows it is the last one.
So [stream](#stream) on a finished run yields every chunk and then waits
forever. A reader bounds itself by this instead, which is also what a
reconnecting reader needs in order to ask for what it has not seen.

###### Parameters

###### runId

`string`

###### options?

[`StreamOptions`](workflow-api.md#streamoptions)

###### Returns

`Promise`\<`number`\>

##### wakeUp()

```ts
wakeUp(runId: string, options?: WakeUpOptions): Promise<number>;
```

Interrupt a run's pending `sleep()` calls, resuming it early. Resolves how
many sleeps were interrupted — `0` when the run was not sleeping, had
already finished, or does not exist.

This is the counterpart of a `sleep()` long enough to be worth shortening,
which is most of the ones worth writing: a review delay, a retry backoff, a
"follow up tomorrow". Without it the only handle on a sleeping run is
[cancel](#cancel), so "send it now" and "throw it away" were the same button.

Pass `correlationIds` to target specific sleeps; omitted, every pending one
in the run is interrupted.

###### Parameters

###### runId

`string`

###### options?

[`WakeUpOptions`](workflow-api.md#wakeupoptions)

###### Returns

`Promise`\<`number`\>

***

### WorkflowCtx

```ts
type WorkflowCtx = {
  runId: string;
  workflow: string;
  now: Promise<number>;
  random: Promise<number>;
  sleep: Promise<void>;
  step: Promise<InferSchemaOutput<S>>;
  uuid: Promise<string>;
  waitFor: Promise<InferSchemaOutput<S> | undefined>;
};
```

The handle a workflow body receives as its second argument.

```ts no-check
// workflows/research.ts
export async function researchFlow(
  input: { topic: string },
  ctx: WorkflowCtx,
) {
  const brief = await ctx.step("writeBrief", () => writeBrief(input.topic));
  const notes = await ctx.step("investigate", () => investigate(brief));
  return { topic: input.topic, notes };
}
```

Deliberately NOT the same object as a tool's `ToolContext`. A tool's `execute`
runs once, inside a live session, and may hold a database handle; a workflow
body is replayed and may hold nothing live at all. Sharing one type would put
`ctx.db` in reach of a body that re-runs it on every resume, which is the bug
the DevKit migration removed and which this must not reintroduce.

#### Methods

##### now()

```ts
now(): Promise<number>;
```

The wall clock, read ONCE and journaled — the same instant on every replay.

The body is replayed from the top, so a plain `Date.now()` here answers
differently on every walk and every duration derived from it is a different
duration. This reads the clock the first time it is reached, journals the
number, and hands the identical number back forever after: it is the moment
the run really reached this line, however many times the line is walked.

```ts
import type { WorkflowCtx } from "@alexkroman1/aai";

declare function transcribe(recording: string): Promise<string>;

export async function timedFlow(input: { recording: string }, ctx: WorkflowCtx) {
  const startedAt = await ctx.now();
  const transcript = await ctx.step("transcribe", () => transcribe(input.recording));
  const finishedAt = await ctx.now();
  return { transcript, elapsedMs: finishedAt - startedAt };
}
```

**Not legal inside a [WorkflowCtx.step](#step)** — the engine refuses one and
the message names the fix. A step's internals are not replayed, so a plain
`Date.now()` inside one is already durable and is what to write there.

###### Returns

`Promise`\<`number`\>

Epoch milliseconds, as `Date.now()` answers them.

##### random()

```ts
random(): Promise<number>;
```

A random float in `[0, 1)`, journaled — the same float on every replay.

ONE draw per call, keyed by its own occurrence, so a loop is correct without
anything further: `random!0`, `random!1`, … each carry their own journaled
value. That is deliberately not a seeded SEQUENCE — a seed would make every
draw's value depend on how many draws came before it, so a body that reaches
a different NUMBER of them before a loop silently re-draws the whole tail,
and it would need a PRNG whose exact algorithm became part of the durable
contract.

The cost is one journal row per call, which is the same trade `ctx.step` makes
and the reason a BULK draw belongs in a step:
`ctx.step("jitter", () => Array.from({ length: 1000 }, Math.random))`.

**Not legal inside a [WorkflowCtx.step](#step)**, for
[WorkflowCtx.now](#now)'s reason.

###### Returns

`Promise`\<`number`\>

##### sleep()

```ts
sleep<Label extends string>(
   label: Label & Literal<Label>, 
   until: number | Date, 
   options?: SleepOptions
): Promise<void>;
```

Wait, durably — for a duration in milliseconds, or until an absolute `Date`.

**This is not `setTimeout`, and the difference is the whole point.** The run
SUSPENDS: the body stops, the process is free, and the engine re-delivers the
run when the time comes — which is what makes "check back tomorrow" a thing a
workflow can express at all.

## `label` is the wait's IDENTITY, exactly as a step's name is

It is journaled as `sleep!<label>#<occurrence>`, so a `label` is what makes
a wait survive a body that reaches a different NUMBER of waits than the walk
that journaled them — a wait behind a condition, a wait added or removed
while a run is in flight. Waits used to be keyed by POSITION alone, and then
every wait after the one that moved read its predecessor's record: measured,
a week-long `ctx.sleep` was skipped in full and the run reported
`completed`, with the clock unmoved. `aai-runtime/workflow-replay-divergence.ts`
carries that reproduction.

So the same rules apply as to [WorkflowCtx.step](#step)'s name, and the
`Literal` constraint says so at the call site: make it a string literal,
give two call sites two labels, and let a loop reuse one — the occurrence
count is what separates the iterations.

**How long it really survives is a property of the JOURNAL**, which the
DEPLOYMENT picks and the runtime's boot line names. On the platform and
against a Postgres it is durable — a wait outlives the body, the worker and
the process, so a multi-day schedule is a thing to write. With neither the
journal is in memory, which is `aai dev`'s default and where a restart loses
every outstanding wait.

A sleep is journaled the first time it is reached, so its wake time is
decided ONCE. That matters because the body is replayed: computing the
deadline from the clock on every replay would push it further out each time
and a run could sleep forever.

**Call it from the BODY, never from inside a [WorkflowCtx.step](#step)** — a
step body that waits fails the run, and the message names the fix.

```ts no-check
await ctx.step("draft", () => draft(input.topic));
await ctx.sleep("review-window", 6 * 60 * 60 * 1000, { correlationId: "review" });
await ctx.step("publish", () => publish(input.topic));
```

###### Type Parameters

###### Label

`Label` *extends* `string`

###### Parameters

###### label

`Label` & `Literal`\<`Label`\>

This wait's identity in the journal. A string LITERAL, for
  the reason above; it is also what `aai workflow` prints for a suspended
  run, so "review-window" reads where `sleep!0` did not.

###### until

`number` \| `Date`

Milliseconds to wait, or the `Date` to wait until. A value
  already in the past returns immediately rather than erroring — a deadline
  that has passed HAS been reached, and a run resuming after a long outage
  meets that case legitimately.

###### options?

[`SleepOptions`](#sleepoptions)

`correlationId` names this wait so
  `ctx.workflows.wakeUp(runId, { correlationIds: [id] })` can end it early,
  which is how a "send it now" tool cuts a scheduled wait short. A `wakeUp`
  naming no ids wakes every outstanding SLEEP on the run — and deliberately
  not a `waitFor`'s deadline, so cutting a schedule short cannot also close
  an approval window.

  Deliberately NOT defaulted from `label`, which is a different question:
  `label` decides which JOURNAL ROW this wait is, and `correlationId`
  decides which waits one `wakeUp` ends. A schedule polled in a loop wants
  one label and one correlation id across every iteration; two independent
  waits want two labels and may well want one shared id.

###### Returns

`Promise`\<`void`\>

##### step()

###### Call Signature

```ts
step<S extends StandardSchemaV1<unknown, unknown>, Name extends string>(
   name: Name & Literal<Name>, 
   fn: () => unknown, 
   options: StepSchemaOptions<S>
): Promise<InferSchemaOutput<S>>;
```

Run `fn` once and journal what it returns; on every later replay, return
the journaled value without running it again.

**`fn` may not wait.** [WorkflowCtx.sleep](#sleep) and
[WorkflowCtx.waitFor](#waitfor) reached inside a step fail the run, because a
suspend unwinds out of the step without journaling it — so the body would
re-run from the top on every delivery, and every later wait in the run would
read the wrong record. Put the wait in the body, between two steps. For a
plain in-step delay that is not durable, use an ordinary timer.

`name` identifies the step in the journal and in `aai workflow` output, so
make it a string LITERAL. A computed one has to produce the same string on
every replay or the walk reads a key that was never written — and a name
built from the run's own data is unreadable in that run's history besides.
A loop needs no name of its own per round: the occurrence count is what
separates the iterations.

The `Literal` constraint is what makes "a string LITERAL" a compile error
rather than a sentence in this paragraph. It is deliberately not exported —
an author meets it as the message tsc prints, never by name — so its doc,
carrying the two shapes it cannot reach and which layer catches each, is in
`sdk/_workflow-ctx-literal.ts` beside the declaration. A harness that means
to pass an unbounded name narrows `ctx.step` through one typed alias rather
than casting at each site.

`options.schema` checks the output on both sides of the journal and makes
the schema's output what this resolves to — see [StepOptions.schema](#schema-1)
for what each side catches, and why a read-side failure is not the step's.

###### Type Parameters

###### S

`S` *extends* `StandardSchemaV1`\<`unknown`, `unknown`\>

###### Name

`Name` *extends* `string`

###### Parameters

###### name

`Name` & `Literal`\<`Name`\>

###### fn

() => `unknown`

###### options

[`StepSchemaOptions`](#stepschemaoptions)\<`S`\>

###### Returns

`Promise`\<[`InferSchemaOutput`](#inferschemaoutput)\<`S`\>\>

###### Call Signature

```ts
step<T, Name extends string>(
   name: Name & Literal<Name>, 
   fn: () => T | Promise<T>, 
   options?: StepOptions
): Promise<T>;
```

###### Type Parameters

###### T

`T`

###### Name

`Name` *extends* `string`

###### Parameters

###### name

`Name` & `Literal`\<`Name`\>

###### fn

() => `T` \| `Promise`\<`T`\>

###### options?

[`StepOptions`](#stepoptions)

###### Returns

`Promise`\<`T`\>

##### uuid()

```ts
uuid(): Promise<string>;
```

A fresh UUID, journaled — the same string on every replay.

What an idempotency key for a downstream API wants: minted once, and still
the same value after a crash, so the retry the far side sees is recognisably
the same request rather than a second one.

```ts
import type { WorkflowCtx } from "@alexkroman1/aai";

declare function charge(amount: number, idempotencyKey: string): Promise<void>;

export async function chargeFlow(input: { amount: number }, ctx: WorkflowCtx) {
  const idempotencyKey = await ctx.uuid();
  await ctx.step("charge", () => charge(input.amount, idempotencyKey));
}
```

**Not a hook TOKEN.** [WorkflowCtx.waitFor](#waitfor)'s token must be DERIVED
from the run's own input, because whoever signals is usually a tool and a tool
cannot see the body's local variables — a journaled uuid is stable across
replays and still unnameable from outside the body.

**Not legal inside a [WorkflowCtx.step](#step)**, for
[WorkflowCtx.now](#now)'s reason.

###### Returns

`Promise`\<`string`\>

##### waitFor()

###### Call Signature

```ts
waitFor<S extends StandardSchemaV1<unknown, unknown>>(token: string, options: WaitForOptions<S> & WaitForSchemaOptions<S>): Promise<InferSchemaOutput<S> | undefined>;
```

Wait for somebody OUTSIDE the run to answer, and resolve what they sent.

Suspends like [WorkflowCtx.sleep](#sleep) and with no deadline at all: the run
waits until `ctx.workflows.signal(token, payload)` is called. That is how a
run parks on a human approval, a review that may take a week, or anything
else somebody else decides.

**The WEBHOOK route reaches this.** `ctx.workflows.publicWebhookUrl(token)`
mints a URL that `createServer` serves, and a delivery to it resolves the
wait: the route calls `WorkflowClient.signal`, which writes the payload
against this hook's own journal row and re-walks the body. So a
payment-callback flow is a supported shape.

It was NOT, until recently, and the note here said so — the URL was served
by the DevKit's own hook table, which knew nothing about this wait and
answered `HookNotFound`. Both hops are covered now: the route→`signal` hop
by `server-workflow-app.test.ts`, and `signal`→resume by
`workflow-in-process.test.ts`.

```ts no-check
// The token is the AUTHOR's, derived so the body and the tool that hands it
// out agree — see below.
const approval = await ctx.waitFor<{ approved: boolean }>(approvalToken(input.id));
if (!approval.approved) return { published: false };
```

**The token must be DERIVED, not random.** Whoever hands the URL out is
usually a tool, and a tool cannot see the body's local variables — so a
random token leaves the run waiting on something nobody can name. Export one
function that computes the token from the run's own input and import it in
both places. This replaced the DevKit's `createHook()`, whose token was
generated body-side for exactly this reason a problem.

**A payload is UNTRUSTED.** It arrives over public HTTP, so validate it with
`options.schema` — the type parameter is a claim, not a check, and until
that option existed this paragraph was advice with no mechanism under it. A
schema SUPERSEDES the parameter, and a payload failing one fails the RUN
fatally with the window left as the delivery found it;
[WaitForOptions.schema](#schema-2) carries why none of the three can be otherwise.

## A deadline is an OPTION, and still the one to reach for

"Wait for an answer, but not forever" is the common case — Temporal's
`timeoutOrUserAction`, and what a retention gate or an approval window is.
Write it as `waitFor(token, { timeoutMs })`, which resolves `undefined` when
the window closes unanswered.

**`Promise.race([ctx.waitFor(t), ctx.sleep(ms)])` does now COMPOSE**, and
this paragraph used to say it could not. A wait no longer unwinds the stack:
it hands back a promise that never settles, so the body walks on and reaches
every wait a `race` or an `all` puts in front of it, and the run suspends
ONCE afterwards carrying the earliest deadline among them. Whichever wait
ends first is the one the race resolves on, on the delivery that ends it.

The parameter is still the better API for a DEADLINE, and for two reasons
the composition does not give you. `timeoutMs` is journaled with the hook,
so one decision fixes the window; a raced `ctx.sleep` is a second wait whose
own deadline is fixed at ITS first reach, so the two agree only by accident.
And the timeout arm CLOSES the hook — a compare-and-set — before the body
continues, which is what stops a signal landing a moment later from making
the next replay answer a window this one timed out. A race has no such
moment. So reach for a race when the two waits are genuinely independent (a
review window beside a retry backoff), not to put a deadline on one wait.

###### Type Parameters

###### S

`S` *extends* `StandardSchemaV1`\<`unknown`, `unknown`\>

###### Parameters

###### token

`string`

Who is being waited for, and also this wait's IDENTITY in
  the journal — it is keyed `hook!<token>#<occurrence>`, which is what makes
  a wait survive a body that reaches a different number of them (see the
  module doc). Two concurrent waits in one body must use different tokens,
  or a single signal resolves whichever the journal registered first and the
  other waits forever.

###### options

[`WaitForOptions`](#waitforoptions)\<`S`\> & [`WaitForSchemaOptions`](#waitforschemaoptions)\<`S`\>

`timeoutMs` closes the window. Measured from the first time
  the wait is REACHED and journaled there, so a replay does not extend it.
  `schema` checks what the signaller actually sent, and decides the type.

###### Returns

`Promise`\<[`InferSchemaOutput`](#inferschemaoutput)\<`S`\> \| `undefined`\>

###### Call Signature

```ts
waitFor<S extends StandardSchemaV1<unknown, unknown>>(token: string, options: WaitForSchemaOptions<S>): Promise<InferSchemaOutput<S>>;
```

###### Type Parameters

###### S

`S` *extends* `StandardSchemaV1`\<`unknown`, `unknown`\>

###### Parameters

###### token

`string`

###### options

[`WaitForSchemaOptions`](#waitforschemaoptions)\<`S`\>

###### Returns

`Promise`\<[`InferSchemaOutput`](#inferschemaoutput)\<`S`\>\>

###### Call Signature

```ts
waitFor<T = unknown>(token: string): Promise<T>;
```

###### Type Parameters

###### T

`T` = `unknown`

###### Parameters

###### token

`string`

###### Returns

`Promise`\<`T`\>

###### Call Signature

```ts
waitFor<T = unknown>(token: string, options: WaitForOptions): Promise<T | undefined>;
```

###### Type Parameters

###### T

`T` = `unknown`

###### Parameters

###### token

`string`

###### options

[`WaitForOptions`](#waitforoptions)

###### Returns

`Promise`\<`T` \| `undefined`\>

#### Properties

##### runId

```ts
readonly runId: string;
```

This run's id — the same value `ctx.workflows.start()` resolved to.

##### workflow

```ts
readonly workflow: string;
```

Key the workflow is declared under in `agent({ workflows })`.

***

### WorkflowDef

```ts
type WorkflowDef<P extends ToolInputSchema = ToolInputSchema, R = unknown> = {
  description?: string;
  input?: P;
  output?: StandardSchemaV1<unknown, R>;
  run: WorkflowBody<InferSchemaOutput<P>, R>;
  uploads?: readonly string[];
};
```

Definition of one durable workflow: its schema, its description, and the
function that is its body.

#### Type Parameters

##### P

`P` *extends* [`ToolInputSchema`](#toolinputschema) = [`ToolInputSchema`](#toolinputschema)

Input schema (any Standard Schema, Zod by convention),
  validated at `start()`. The input is serialized into the run record, so it
  must be JSON-serializable.

##### R

`R` = `unknown`

What the body resolves with — inferred from the declared
  [WorkflowDef.output](#output) schema when there is one, and from the function
  otherwise. It reaches a caller as `WorkflowRunSnapshot`'s `output`, so
  passing the workflow to `start`/`get`/`find` is what makes a completed
  run's result typed instead of `unknown`.

#### Properties

##### description?

```ts
optional description?: string;
```

What this workflow does. Not shown to an LLM — workflows are started by code, not chosen by a model.

##### input?

```ts
optional input?: P;
```

Schema for the run input, validated at `start()` so a bad payload fails at the call site.

##### output?

```ts
optional output?: StandardSchemaV1<unknown, R>;
```

Schema for what a COMPLETED run answers with — `input` from the other end.

Optional, and a workflow that declares none behaves exactly as it always
did. What declaring one buys is three things a body's inferred return type
cannot:

- **The value is checked where the run completes**, once, against this
  schema; a body that returns something the declaration denies fails the
  run rather than reporting `completed` with an output its own workflow
  says is impossible. A run's output crosses a durable journal, a
  typed-JSON codec and an HTTP hop before a page reads it, and
  `useWorkflowRun<R>`'s `run.output` is otherwise an unchecked CLAIM about
  everything that happened in between.
- **[WorkflowOutputOf](workflow-api.md#workflowoutputof) reads THIS**, so a page's type comes from the
  declaration rather than from inferring the body — which is what lets an
  annotated `agent.ts` resolve it without the body's signature. See that
  type for the circularity that removes.
- **A page can render results the way it renders the form**, because the
  listing serves it as JSON Schema ([WorkflowSummary.outputSchema](workflow-api.md#outputschema)).

Any Standard Schema, Zod by convention — the same acceptance as `input`,
and not a TypeScript type for the same reason: a type is erased, and this
has to be checked at run time and converted for a browser.

What is stored is the schema's PARSED value, exactly as `start()` stores
the parsed input. So an unknown key a zod object strips is not in what the
caller reads back, and the type a caller holds is a promise the run kept
rather than a claim about it.

##### run

```ts
run: WorkflowBody<InferSchemaOutput<P>, R>;
```

The workflow body.

Takes the validated input and a [WorkflowCtx](#workflowctx). The input is ONE
object rather than a positional list on purpose — it is schema-validated,
and a schema describes one value.

##### uploads?

```ts
optional uploads?: readonly string[];
```

Input properties that carry an UPLOAD ID rather than a value of their own.

A run's input is journaled and replayed on every resume, so a file's bytes
may not travel in it — the bytes go to `POST /workflows/uploads` and the
input carries the id it answered with, which a step reads windows of through
`readUpload`. Naming the property here is what makes that automatic at both
ends: `<WorkflowFields>` renders a file picker for it instead of a text box,
and `useWorkflowSubmit` uploads the chosen file and substitutes its id.

Declared on the workflow rather than in the schema because the schema may be
any Standard Schema, and a marker inside one would only work for the library
that happened to carry it. The property itself stays an ordinary
`z.string()` — an upload id is what the run really receives.

## Variables

### ASSEMBLYAI\_TTS\_VOICES

```ts
const ASSEMBLYAI_TTS_VOICES: Readonly<Record<AssemblyAITtsVoiceId, AssemblyAITtsVoiceInfo>>;
```

The voice catalog and the type `agent({ voice })` is written against.

Both were FORGOTTEN exports here — `AgentParams.voice` is typed
`AssemblyAITtsVoice`, and the catalog is the only place the ids are
checkable — so an author reaching for the field this barrel documents had to
import from `@alexkroman1/aai/tts` to name either. The TTS subpath keeps
them too: it is where an explicit `assemblyAITts({ voice })` stage is
written.

***

### DEFAULT\_STEP\_MAX\_ATTEMPTS

```ts
const DEFAULT_STEP_MAX_ATTEMPTS: 3 = 3;
```

Attempts a step gets when [StepOptions.maxAttempts](#maxattempts) says nothing.

Three, which is what the DevKit's queue hardcoded — kept deliberately so the
migration changes no retry behaviour it does not have to. Note attempts ARE
burned by failed boots, so a step can reach its ceiling without ever having
run its body; that was true before this change and is unchanged by it.

***

### DEFAULT\_SYSTEM\_PROMPT

```ts
const DEFAULT_SYSTEM_PROMPT: "You are a voice agent in a real-time spoken conversation. What you\nreceive is a live speech transcript, and everything you write will be\nspoken aloud by a text-to-speech system and shown as plain text.\nAgent-specific instructions may follow these defaults. They decide WHAT\nyou do — policy, persona, scope, what to collect and when — and they win\non all of it. They do not change how this channel works: the LISTENING\nand SPEAKING sections below are facts about a live transcript and a\nreal-time voice, not preferences, and they hold whatever a later\ninstruction says. When a later instruction asks for something those\nfacts make useless — most often asking the caller to repeat or spell\nsomething you already have — honour what it is trying to achieve and\nfollow the section's method for achieving it.\n\n## PERSONALITY\n- Unless the agent's instructions say otherwise: warm, calm, and\n  competent. Sound like a capable person, not a phone tree.\n\n## SPEAKING\n- Keep the whole reply to two sentences, about thirty spoken words.\n  Going long is the single most expensive habit on a phone call: the\n  longer you talk, the more likely the caller cuts in, and everything\n  after that point is never heard.\n- Your FIRST sentence is at most eight words and carries the answer or\n  the next question — never a preface, an acknowledgment, or a\n  restatement of what the caller just said.\n  Too long: \"Thanks for that. I will look up your account now. I found\n  your account, and I can see two orders on it.\"\n  Say instead: \"Found your account. Two orders — which has the water\n  bottle?\"\n- Write exactly as you would say it out loud to a friend. Contractions\n  sound better spoken (\"I'll\", \"it's\", \"don't\"). No markdown, bullet\n  points, code, headings, emoji, stage directions, or sound effects —\n  none of it can be spoken.\n- When the caller asks HOW MANY, lead with the number that answers what\n  they asked — how many records actually match their question, not how\n  big the list you looked at was. Leave the ones that don't qualify out\n  of the number and never make the caller do the subtraction; a total\n  plus an exclusion is not an answer.\n  Asked \"how many can I still pick from?\": say \"Ten to choose from.\"\n  Not: \"There are twelve, and two are out.\"\n- To list things, say \"First,\" \"Next,\" \"Finally.\" Never read out a long\n  list: give the count that matches what they asked for, name at most\n  two, and ask which one they mean (\"Five items on that order — the\n  headphones and the vacuum, plus three more. Which one?\").\n- Say numbers, amounts, and dates the way a person says them (\"one\n  hundred fifty-four dollars, on March third\"). An IDENTIFIER is the\n  exception, and the rule for it is all-or-nothing: any code that mixes\n  letters and digits, or that is not a word, is spoken one character at\n  a time from end to end.\n  Right: \"A-B-C-one-two-three.\"\n  Wrong: \"ABC one hundred twenty three\" — the letters spelled and the\n  digits read as a number is the common failure, and it is unusable:\n  the caller cannot tell \"123\" from \"one two three\" from \"one twenty\n  three\".\n  Wrong: \"Delive\" — a code is never pronounced as if it were a word.\n  When a quantity sits next to a code, put the unit between them, or\n  they run together into one unsayable token: \"two of K-two\", never\n  \"two K two\".\n- Speak the language the caller is speaking. Switch only when they do —\n  never on your own.\n- Ask at most one question per turn, and make it the one that unblocks\n  the most.\n- Vary your openers — don't start consecutive replies with the same\n  acknowledgment. If the caller interrupts, stop and address what they\n  said.\n- Never verbalize internal reasoning, tool names, system mechanics, or\n  technical failures.\n\n## LISTENING\n- The transcript carries fillers, pauses, false starts, and\n  self-corrections. Read through the noise to the caller's final intent\n  and act on it. When they correct themselves (\"Boston... actually,\n  Chicago\"), use only the last value.\n- Respond only to speech directed at you. If a turn is empty, garbled,\n  or clearly background noise or a side conversation, say briefly that\n  you didn't catch that — never act on it. Otherwise act on your best\n  understanding rather than stalling.\n- Take a value the way a person says it, in one piece, and TRY it before\n  asking for it spelled. A spelling request costs a full round trip and\n  transcribes no better: spelled letters lose their word boundaries and\n  lose their tail to a pause, a cough, or a breath, which reads as a\n  valid value and is not. If the caller volunteers something you didn't\n  ask for, use it; never re-collect what you already have in another\n  form.\n- Write spoken identifiers in their normal written form, not as they\n  were said. Drop spoken separators (\"K dash 2\" is K2, \"P dash five\n  dash two\" is P52), join spelled-out characters (\"A B C one two three\"\n  is ABC123), and add nothing the caller did not say (\"Z K 3 F F W\" is\n  ZK3FFW, never ZEDK3FFW). A spelled-out name is still a name in\n  ordinary title case (Maria Garza, not MARIA GARZA).\n- Don't read spelled input back letter by letter — it's slow and\n  invites interruption. Confirm briefly and move on (\"Okay, Yusuf\n  Rossi, ZIP 1-9-1-2-2 — one moment\"). Re-spell a single character only\n  to resolve a genuine ambiguity (\"Was that F or S?\"). The one time to\n  read an identifier back in full is right before an action that's hard\n  to undo.\n\n## TOOLS\n- Never fabricate. If you don't know something, look it up with a tool;\n  if no tool can answer it, say so. Never state data from memory that a\n  tool can retrieve: every confirmation number, price, total, seat, or\n  other detail you speak must come from a tool result.\n- Act first, ask second: if the caller's words contain everything a\n  tool needs, call it immediately. Ask only when a required value is\n  genuinely missing — and never fill one with a placeholder or a guess.\n  A date, time, or priority the caller hasn't stated is theirs to give,\n  not yours to pick.\n- Report RESULTS, never intentions. Don't announce what you're about\n  to do — the caller can't act on a plan, and each announcement is\n  another sentence they can interrupt. Stay silent while the calls run\n  and speak once you have the answer.\n  Wrong: \"I will look up your account now. I found your account. I\n  will check that order now.\"\n  Right: nothing, until the calls are done — then: \"Your order's\n  delivered. Both items can be exchanged.\"\n- Never say an action is done unless a tool call returned success for\n  it. Announcing an action is not performing it: if you say you're\n  looking up, booking, changing, or cancelling something, make the\n  matching tool call in that same turn. Carrying something over (a\n  seat, a bag allowance, a preference) is itself an action — it needs\n  its own tool call and doesn't happen because a related call\n  succeeded.\n- Copy values from prior tool results exactly. Never retype, reformat,\n  or construct an ID from a pattern — if you don't have it, look it up\n  first, then use it.\n- The same rule covers MONEY and COUNTS, and it is the one most often\n  broken: speak the figure from the field that holds it. A total you\n  worked out yourself is a total you invented, and the caller acts on\n  it.\n- A lookup that fails on a spoken value is a MIS-HEARING until proven\n  otherwise, not a missing record. Before you say a word about it, work\n  this list in order and stop at the first step that succeeds:\n  1. Re-read the conversation. If the caller gave this value more than\n     once, or you said it back and they agreed, retry EACH earlier\n     version before anything else. An earlier turn is evidence you\n     already hold, not history.\n  2. Retry the plausible confusions of what you have — F/S, B/P/V,\n     D/G/T, M/N, and a missing or doubled final letter.\n  3. Retry with a different identifier you already hold. Digits\n     transcribe better than names — prefer a number when one is\n     accepted.\n  4. Only now ask the caller, and ask for something DIFFERENT: a new\n     identifier, or the single character you're unsure of (\"M as in\n     Mike?\"). Asking for the same value again produces the same\n     transcript, so it is never step one and never repeats.\n  When every identifier is exhausted, say what you can still do.\n- On a tool error, read the message. Fix the specific problem and retry\n  once with something actually different — never resend arguments that\n  already failed, and never pretend a failed call succeeded. If it\n  still fails or returns nothing, don't mention tools, APIs, or errors:\n  say plainly what you couldn't get and offer a next step.\n- Finish the whole request, ACROSS TURNS. When the caller asks for\n  several things, keep the ones you haven't answered and come back to\n  them the moment you can — a question they had to repeat is a question\n  you dropped. If one has to wait on a step in progress, say so in a\n  clause rather than letting it fall away. Never stop halfway and ask\n  \"shall I continue?\".\n- Before an action that's hard to undo, state what you're about to do\n  and get a clear yes. When the caller's request already says exactly\n  what to do, that request is the authorization — execute it.\n- Any number you are about to say that you worked out yourself — a\n  count, a total, a difference, a date offset — comes from enumerating\n  the records one at a time, or from a calculator tool if one exists.\n  Counting how many records meet a condition is arithmetic. A number\n  you did not enumerate is a guess; don't say it.\n- If the caller questions a number or a fact you already gave, re-derive\n  it from the tool result before answering, and say the corrected value\n  plainly. Your own previous reply is not a source, and agreeing with\n  yourself is not confirming. Call the tool again if the record no\n  longer covers it.\n- If you're stuck after exhausting the retries above, say so, offer what\n  you can do instead, and hand off if a transfer or escalation tool\n  exists.";
```

Default system prompt used when `systemPrompt` is not provided.

A general-purpose base for any kind of voice agent — assistant,
support, tutor, game, companion. It covers only what every spoken
conversation needs (voice delivery, transcript noise, tool fidelity)
and leaves the persona and domain rules to the agent's own
instructions, which take precedence over these defaults.

#### Remarks

**What it contains.** Five sections, joined by blank lines, in this order —
the last is included only when the session has tools:

1. *(role framing)* — you are a voice agent on a live transcript; later
   agent instructions decide WHAT you do and do not override the two
   channel sections below.
2. `## PERSONALITY` — warm, calm, competent; fully overridable.
3. `## SPEAKING` — two sentences per reply, an eight-word first sentence,
   no markdown, how to say numbers and identifiers, one question per turn.
4. `## LISTENING` — read through fillers and self-corrections, take a value
   in one piece before asking for it spelled, normalize spoken identifiers.
5. `## TOOLS` — never fabricate, act first and ask second, report results
   rather than intentions, and the mis-hearing retry ladder.

**`agent({ systemPrompt })` does NOT replace any of it — it is APPENDED.**
`buildSystemPrompt` always emits these sections and then adds your
prompt last, under a header saying it overrides them where they conflict. So
write only your own domain rules:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Cart",
  systemPrompt: "Only discuss items in the catalog.",
});
```

**Do not interpolate this constant into that string.** This doc used to show
exactly that (`` `${DEFAULT_SYSTEM_PROMPT}\n\nOnly discuss…` ``) on the false
premise that it was replaced, which sent the ~10,000-character voice core
twice — the repetition this module's whole section split exists to prevent,
paid for in tokens on every turn and in a prompt that contradicts itself
where the two copies land under different precedence headers.
`buildSystemPrompt` now strips a leading copy rather than emitting it
again, so an agent that followed the old advice is corrected on upgrade; that
is a repair, not an invitation to keep composing.

**It is exported to be READ, not composed**: printed while tuning an agent,
diffed across SDK versions, or asserted on in a test. The full text is
assembled from parts and is not reproduced here — a second copy in a comment
would drift from the one the agent runs.

***

### withLock

```ts
const withLock: <T>(lock: (key: string, opts?: KeyedLockOptions) => Promise<() => void>, key: string, fn: () => Promise<T>, opts?: KeyedLockOptions) => Promise<T>;
```

Run `fn` while holding a keyed lock, releasing it in every outcome.

#### Type Parameters

##### T

`T`

#### Parameters

##### lock

(`key`: `string`, `opts?`: [`KeyedLockOptions`](#keyedlockoptions)) => `Promise`\<() => `void`\>

##### key

`string`

##### fn

() => `Promise`\<`T`\>

##### opts?

[`KeyedLockOptions`](#keyedlockoptions)

#### Returns

`Promise`\<`T`\>

## References

### errorDetail

Re-exports [errorDetail](utils.md#errordetail)

***

### errorMessage

Re-exports [errorMessage](utils.md#errormessage)

***

### isToolFailure

Re-exports [isToolFailure](utils.md#istoolfailure)

***

### pushCapped

Re-exports [pushCapped](utils.md#pushcapped)

***

### responseErrorMessage

Re-exports [responseErrorMessage](utils.md#responseerrormessage)

***

### toolFailure

Re-exports [toolFailure](utils.md#toolfailure-1)

***

### ToolFailure

Re-exports [ToolFailure](utils.md#toolfailure)
