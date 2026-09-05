# tools

`@alexkroman1/aai/tools` — the network builtins, callable from your own tool code.

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

### fetchJson()

```ts
function fetchJson<T = UntypedJsonBody>(url: 
  | string
  | {
  headers?: Record<string, string>;
  url: string;
} & CallOptions, options?: {
  headers?: Record<string, string>;
} & CallOptions): Promise<ToolFailure | T>;
```

GET a URL and return its parsed JSON.

Answers `{ error, url }` rather than throwing on an HTTP failure or an
oversized body, matching what the model-facing builtin returns. Narrow it with
`isToolFailure` — see the module doc for why the union is in the type.

#### Type Parameters

##### T

`T` = [`UntypedJsonBody`](#untypedjsonbody)

#### Parameters

##### url

  \| `string`
  \| \{
  `headers?`: `Record`\<`string`, `string`\>;
  `url`: `string`;
\} & [`CallOptions`](#calloptions)

##### options?

\{
  `headers?`: `Record`\<`string`, `string`\>;
\} & [`CallOptions`](#calloptions)

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
