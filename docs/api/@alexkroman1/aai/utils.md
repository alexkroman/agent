# utils

Shared utility functions (the `@alexkroman1/aai/utils` subpath).

For user tool code: `errorMessage`, `errorDetail`, `safeJsonParse`,
`toolFailure`, `isToolFailure`, `pushCapped`, and `createKeyedLock`. The
remaining exports are framework
plumbing shared with the sibling packages. The module stays free of zod and
other heavy runtime dependencies so the CLI can import it on every
invocation without a startup cost.

That budget is also why `stepSpeak` is here at all rather than beside the TTS
providers: the synthesizer needs a WebSocket client, so what this module
carries is the SLOT and the WAV framing — the same split `stepFetch` makes
with its undici dispatcher, and for the same measured reason.

That zod-free property is why `omitUndefined` lives here rather than on
`/internal` alongside the other cross-package infrastructure: `/internal`
re-exports a schema helper that pulls zod, so importing anything from it pulls
zod's whole module graph — and the CLI loads this module on every invocation.

`createKeyedLock` is the one export with a runtime dependency (`p-timeout`,
for its optional acquire deadline). Deliberate, and measured against the
rule above rather than around it: p-timeout is 2.4 KB with an empty
dependency list, where the cost this rule exists to keep off the startup
path is zod's module graph. It belongs on the PUBLIC subpath because the
hazard it addresses is an agent author's — the LLM loop runs a step's tool
calls concurrently, so two async mutators of one external resource interleave
— and `/internal` would be telling users to import internal API. (Per-session
state is not that case any more: `sessionSlot`'s `update` window is
synchronous, so it has nothing to serialize.)

## Functions

### errorDetail()

```ts
function errorDetail(err: unknown): string;
```

Extract a detailed error string (message + stack) for diagnostic logging.

#### Parameters

##### err

`unknown`

#### Returns

`string`

***

### errorMessage()

```ts
function errorMessage(err: unknown): string;
```

Extract an error message from an unknown thrown value.

#### Parameters

##### err

`unknown`

#### Returns

`string`

***

### isToolFailure()

```ts
function isToolFailure(value: unknown): value is ToolFailure;
```

Whether a value is a [ToolFailure](#toolfailure).

The guard exists because failures PROPAGATE: a helper resolving an order
returns `Order | ToolFailure`, and its caller forwards the failure
unchanged rather than re-wording it. `if ("error" in value)` works only
once the value is known to be an object, which is the check this bundles.

#### Parameters

##### value

`unknown`

#### Returns

`value is ToolFailure`

#### Example

```ts
import { isToolFailure, type ToolFailure } from "@alexkroman1/aai";

type Order = { id: string; total: number };

function findOrder(id: string): Order | ToolFailure {
  return { error: `Order ${id} not found.` };
}

function orderTotal(id: string): number | ToolFailure {
  const order = findOrder(id);
  if (isToolFailure(order)) return order;
  return order.total;
}
```

***

### pushCapped()

```ts
function pushCapped<T>(
   list: T[], 
   item: T, 
   max: number): T[];
```

Append to a list, dropping the oldest entries so it never exceeds `max`.
Mutates `list` in place and returns it.

For the append-only lists an agent keeps in a `sessionSlot` — a timeline, an
activity feed, a session log. Every one of them feeds an LLM summary or a
`syncState` payload, so an uncapped list grows what the model reads and
what crosses the wire for the length of the call, unboundedly. In place
rather than returning a new array because the list is usually a property of
the state object (`incident.timeline`), and reassigning that is a second
thing to remember.

`max` below 1 keeps nothing — including the entry just appended — which is
what "a cap of zero" has to mean.

#### Type Parameters

##### T

`T`

#### Parameters

##### list

`T`[]

##### item

`T`

##### max

`number`

#### Returns

`T`[]

#### Example

```ts
import { pushCapped } from "@alexkroman1/aai";

const log: string[] = ["a", "b", "c"];
pushCapped(log, "d", 3); // ["b", "c", "d"]
```

***

### responseErrorMessage()

```ts
function responseErrorMessage(res: Response, label?: string): Promise<string>;
```

Read a failed `Response`'s error sentence — the one every route this SDK
serves answers with.

Each `4xx`/`5xx` an agent produces carries `{ "error": "<sentence>" }`, and
that sentence is the whole diagnostic: an unknown workflow names the ones
that are declared, a rejected input names the schema issues, a 404 from an
agent that declares no workflows names both of its causes. Anything ELSE in
the path — a proxy, a CDN, a platform broker answering while a sandbox boots
— replies with a body that shape does not fit, so the status is reported
instead, with a short preview of whatever did come back.

`label` names the surface that answered and appears ONLY in that fallback:
when the agent gave its own sentence, prefixing it would put our words in
front of the ones worth reading.

It never throws and never rejects — a body that cannot be read at all
degrades to the bare status, because this runs on a path that is already
reporting a failure and a second one there has nowhere to go.

It deliberately does NOT reuse [isToolFailure](#istoolfailure), whose object shape is
identical today: that guard answers for a TOOL's result union, and the two
contracts are free to move apart.

#### Parameters

##### res

`Response`

##### label?

`string`

#### Returns

`Promise`\<`string`\>

#### Example

```ts
import { responseErrorMessage } from "@alexkroman1/aai/utils";

async function startRun(url: string): Promise<string> {
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(await responseErrorMessage(res, "Workflow API"));
  return ((await res.json()) as { runId: string }).runId;
}
```

***

### toolFailure()

```ts
function toolFailure(message: string): ToolFailure;
```

Build a [ToolFailure](#toolfailure) — the failure a tool `execute` RETURNS when the
model should see it and recover.

The pair to [isToolFailure](#istoolfailure), and named to say so. The object literal
`{ error: message }` means exactly the same thing and stays perfectly good
TypeScript; this exists so that a tool reaching for "how do I report a
failure?" finds the constructor next to the guard rather than the framework's
own internal wire form, which is a pre-serialized string this guard does not
narrow.

#### Parameters

##### message

`string`

#### Returns

[`ToolFailure`](#toolfailure)

#### Example

```ts
import { tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";

const orders = new Map<string, { id: string; total: number }>();

export const orderTotal = tool({
  description: "Look up an order's total",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => {
    const order = orders.get(id);
    if (!order) return toolFailure(`Order ${id} not found.`);
    return { total: order.total };
  },
});
```

## Type Aliases

### ToolFailure

```ts
type ToolFailure = {
  error: string;
};
```

A tool result that reports a recoverable failure to the LLM.

Return one from `execute` (instead of throwing) when the failure is
something the model should see and act on — "no order matches that
description, ask which one" — rather than an internal fault. The runtime
serializes it like any other result, so it reaches the model as
`{"error":"…"}` and reaches a test as an inspectable object.

A tool that returns failures declares them in its own result union
(`Order | ToolFailure`), which is what makes [isToolFailure](#istoolfailure) a
narrowing guard at every call site that forwards one.

#### Properties

##### error

```ts
error: string;
```

## References

### createKeyedLock

Re-exports [createKeyedLock](index.md#createkeyedlock)

***

### isRecord

Re-exports [isRecord](index.md#isrecord)

***

### KeyedLock

Re-exports [KeyedLock](index.md#keyedlock)

***

### KeyedLockOptions

Re-exports [KeyedLockOptions](index.md#keyedlockoptions)

***

### KeyedLockTimeoutError

Re-exports [KeyedLockTimeoutError](index.md#keyedlocktimeouterror)

***

### omitUndefined

Re-exports [omitUndefined](index.md#omitundefined)

***

### safeJsonParse

Re-exports [safeJsonParse](index.md#safejsonparse)

***

### withLock

Re-exports [withLock](index.md#withlock)
