# tools

`@alexkroman1/aai/tools` — the network builtins, callable from your own tool
code, and `builtinTool(name)`, any builtin as the DEF a spec reads it through.

A FACADE. The subpath resolves here rather than at `agent-tools.ts`, which buys two
things the direct form could not. That module can be SPLIT as it grows without
moving the published entry point — the path an implementation file happens to
have is not a thing to promise anyone — and a name it gains next reaches the
public surface only when a line is added below, rather than the moment it is
written.

Named re-exports rather than `export *` for the second half of that: the
wildcard form re-exports whatever arrives, and needs a `noReExportAll`
suppression the escape-hatch ratchet only lets move down.

## Functions

### builtinTool()

```ts
function builtinTool(name: BuiltinTool): ToolDef;
```

The builtin tool `name`, as a DEF — the handle a spec or an eval reads a
builtin through, the way it reads any other tool through the tool's def.

A tool is reached by its def, never by its name string: a `tools/` file's
default export, a speaker's `tools` entry. A builtin has neither — it is
minted by the runtime from the name an agent lists in `builtinTools`, with
the runtime's own dependencies injected — so this is the import that stands
in for the file: `toolResultIn(turn.toolCalls, builtinTool("workflow_cancel"))`
reads what the deployed agent's `workflow_cancel` answered, matched by the
name the def was minted under.

What comes back is a REAL def, built with no injected dependencies: the
static builtins (`think`, `calculate`, …) execute as deployed; a network
builtin takes the SSRF-screened default fetch; `run_code` refuses outside a
sandbox and the three `workflow_*` builtins describe a run by its status
sentence alone, since no agent's `describeRun` was handed in. It is not in
any agent's tool table — the runtime merges builtins in at session start —
so a `toolRunner` does not find it; a spec that wants to CALL one calls its
`execute` directly, with a `createToolContext()`.

#### Parameters

##### name

[`BuiltinTool`](index.md#builtintool)

#### Returns

[`ToolDef`](index.md#tooldef)

#### Throws

When `name` is not a builtin this SDK ships, naming the ones it does.

#### Example

```ts
import { builtinTool } from "@alexkroman1/aai/tools";
import { createToolContext } from "@alexkroman1/aai/testing";

const calculate = builtinTool("calculate");
const answer = await calculate.execute({ expression: "6 * 7" }, createToolContext());
console.log(answer); // the builtin's own result
```

***

### fetchJson()

```ts
function fetchJson<T = UntypedJsonBody>(url: 
  | string
  | {
  url: string;
} & {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
} & CallOptions, options?: FetchJsonOptions): Promise<ToolFailure | T>;
```

Request a URL (GET unless told otherwise) and return its parsed JSON.

Answers `{ error, url }` rather than throwing on an HTTP failure or an
oversized body, matching what the model-facing builtin returns. Narrow it with
`isToolFailure` — see the module doc for why the union is in the type.

```ts
import { fetchJson } from "@alexkroman1/aai/tools";

export async function airQuality(key: string, latitude: number, longitude: number) {
  return await fetchJson("https://airquality.googleapis.com/v1/currentConditions:lookup", {
    method: "POST",
    headers: { "x-goog-api-key": key },
    body: { location: { latitude, longitude } },
  });
}
```

#### Type Parameters

##### T

`T` = [`UntypedJsonBody`](#untypedjsonbody)

#### Parameters

##### url

  \| `string`
  \| \{
  `url`: `string`;
\} & \{
  `body?`: `unknown`;
  `headers?`: `Record`\<`string`, `string`\>;
  `method?`: `string`;
\} & [`CallOptions`](#calloptions)

`string`

***

\{
  `url`: `string`;
\} & \{
  `body?`: `unknown`;
  `headers?`: `Record`\<`string`, `string`\>;
  `method?`: `string`;
\} & [`CallOptions`](#calloptions)

##### options?

[`FetchJsonOptions`](#fetchjsonoptions)

#### Returns

`Promise`\<[`ToolFailure`](index.md#toolfailure) \| `T`\>

***

### visitWebpage()

```ts
function visitWebpage<T = UntypedJsonBody>(url: 
  | string
  | {
  url: string;
} & CallOptions, options?: CallOptions): Promise<ToolFailure | T>;
```

Fetch a page and return its content as clean text.

Answers `{ error }` for a page it could not read — narrow with
`isToolFailure`, and see the module doc for why.

#### Type Parameters

##### T

`T` = [`UntypedJsonBody`](#untypedjsonbody)

#### Parameters

##### url

  \| `string`
  \| \{
  `url`: `string`;
\} & [`CallOptions`](#calloptions)

##### options?

[`CallOptions`](#calloptions)

#### Returns

`Promise`\<[`ToolFailure`](index.md#toolfailure) \| `T`\>

***

### webSearch()

```ts
function webSearch<T = UntypedJsonBody>(query: 
  | string
  | {
  maxResults?: number;
  query: string;
} & CallOptions, options?: CallOptions): Promise<ToolFailure | T>;
```

Search the web (DuckDuckGo-backed, no API key) and return ranked results.

Answers `{ error }` when both DuckDuckGo endpoints refuse — a `403` or a bot
challenge, which is a routine outcome rather than an edge case. Narrow with
`isToolFailure`: an unnarrowed `?? []` reads as "the web has nothing", which is
a different claim and the one this repo shipped twice.

#### Type Parameters

##### T

`T` = [`UntypedJsonBody`](#untypedjsonbody)

#### Parameters

##### query

  \| `string`
  \| \{
  `maxResults?`: `number`;
  `query`: `string`;
\} & [`CallOptions`](#calloptions)

##### options?

[`CallOptions`](#calloptions)

#### Returns

`Promise`\<[`ToolFailure`](index.md#toolfailure) \| `T`\>

## Type Aliases

### CallOptions

```ts
type CallOptions = {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
};
```

**`Input`**

#### Properties

##### fetch?

```ts
optional fetch?: typeof globalThis.fetch;
```

For TESTS, and callers must leave it unset — same rule as `safeFetch`'s.
Naming an implementation is how you accidentally opt out of the screening
this whole module exists to keep.

##### signal?

```ts
optional signal?: AbortSignal;
```

Cancel the request — pass `ctx.signal`, which a tool always has.

A page fetch and a search are the two slowest things a tool does and the
ones a barge-in most wants back, and without this the only way to abort one
was to abandon these wrappers for a raw `fetch` — i.e. to opt out of the
screening, the header stripping and the size caps at the same time. That is
the whole reason the option is here: the compliant path must not be the one
that gives up the safe fetch.

An abort REJECTS (fetch's own `AbortError`) rather than answering
`{ error }`. The failure-as-a-result contract above is about telling the
MODEL something useful, and a cancelled turn has no model left to tell —
the tool's own `await` is being unwound. Same shape as the existing
per-request timeout, which has always thrown.

***

### FetchJsonOptions

```ts
type FetchJsonOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
} & CallOptions;
```

**`Input`**

What [fetchJson](#fetchjson) takes beside the URL.

#### Type Declaration

##### body?

```ts
optional body?: unknown;
```

A request body, sent as JSON (`content-type: application/json`).

##### headers?

```ts
optional headers?: Record<string, string>;
```

Extra headers. Credential and routing headers (`authorization`, `cookie`, `host`…) are dropped, as the builtin drops them.

##### method?

```ts
optional method?: string;
```

The HTTP method, e.g. `"POST"`. Defaults to GET, or POST when a `body` is
given. Only a direct caller can pick one: the model-facing `fetch_json`
builtin is GET-only.

***

### UntypedJsonBody

```ts
type UntypedJsonBody = Record<string, DefaultToolResult>;
```

What an unparameterized call answers with — see the module doc for why this
rather than `DefaultToolResult` (which is `any`, and absorbs the
`| ToolFailure` the whole contract is carried by) or `unknown` (which
survives the narrowing and makes every read a cast).

EXPORTED because it is the declared default of all three functions below, so
it is part of what a caller reads back and part of what they are overriding
when they pass a `T`. Left unexported it was a name in three public
signatures that resolved to nothing a reader could follow — which TypeDoc
reports as a warning and the docs build turns into a failure.
