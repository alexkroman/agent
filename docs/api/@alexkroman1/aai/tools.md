# tools

The network builtins, callable from your own tool code.

`web_search`, `visit_webpage` and `fetch_json` are MODEL-facing: they are
declared to the LLM and the LLM calls them. Nothing exposed them to the
`execute` body of a tool the author wrote — and authors kept reaching for
them anyway. Across the starter evals, nine separate runs wrote
`ctx.fetch_json(...)`, `ctx.run_code(...)` or
`import { fetch_json } from "@alexkroman1/aai"`, most at several call
sites, and each one cost a build round.

That is not a misunderstanding worth correcting with documentation. Someone
writing a tool that needs a REST call reasonably expects the framework's
REST call to be reachable; "which side of the model boundary does this live
on" is framework internals, and the author should not have to hold it. So
the capability is exposed rather than the rule restated.

These are the SAME implementations the builtins use, reached through the
same factories — so URL screening, redirect re-validation, credential-header
stripping, response-size caps and timeouts all apply identically. Whether
the URL is screened at all is `builtinFetch`'s decision, not one made here:
inside a container it is plain `pinnedFetch` (the container is the
boundary, and tool code has open egress anyway), and on a developer's own
machine under `aai dev` it is `safeFetch`, because there the host IS
someone's laptop.

`run_code` is deliberately NOT here. It exists to run code the MODEL wrote;
tool code that wants to compute something can just compute it.

Two shapes of every call, and a permissive result, both for the same
reason: the first version of this module took only positional arguments
and returned `Promise<unknown>`, and in the very next eval EVERY call site
had to cast — `const data: any = await fetchJson(url)`,
`(await webSearch(query)) as any[]`. That is the mistake `useToolResult`
and `ToolCallInfo.args` had already been fixed for, reintroduced in a new
API hours later. A remote JSON body is not knowable by the framework, so
`unknown` buys no safety here — it only makes correct code fail to compile,
and it does not stop at the first read: `isToolFailure` narrows an `unknown`
to `ToolFailure` on the true side and to `unknown` on the false one, so the
cast comes back one line later. Pass a type argument
(`fetchJson<Quote>(url)`) for real checking.

The object form exists because agents reach for the shape they already
know from the model-facing builtin (`{ query, max_results }`), and guessing
wrong cost a build round.

## All three can ANSWER with a failure, and the type says so

A builtin's failure IS its result — `{ error }` rather than a throw — because
these are model-facing and a tool that hands the result straight back to the
model should say something useful rather than fail the turn. That contract is
right and is not changing. What was wrong is that it was invisible: they were
typed `Promise<T>`, so a caller that named a shape got that shape and nothing
told it a failure was possible.

**Every caller in this repo got it wrong, three for three**, and all three the
same way — `(results.results ?? [])` and `page.content ?? ""`, which turn a
real failure into an empty answer. Measured 2026-08-13: DuckDuckGo answered
`403` to both endpoints from this machine, so `research-workflow` and `plan-and-execute`
were both reporting "No results." for every search, with the 403 nowhere.
`research-workflow` even had a `catch` for it, carefully commented — and a `catch`
cannot see a returned value, so it never ran.

So the return type is `T | ToolFailure` and `isToolFailure`
(`@alexkroman1/aai/utils`) is how a caller narrows it.

**`T` therefore must not default to `any`.** It did — to
`DefaultToolResult` — and `any | ToolFailure` is `any`, so the union the
paragraph above exists for was erased for exactly the callers that never
named a shape, i.e. the three that shipped the bug. `const a = await
fetchJson(url); a.no.such.field` was zero errors.

The default is `Record<string, DefaultToolResult>` instead — the shape
`ToolCallInfo.args` already uses, and the only one that keeps BOTH
properties. The union survives, so the first field read off an unnarrowed
result fails with `Property 'price' does not exist on type 'ToolFailure'`,
which names the thing that was forgotten; and past the narrowing a field is
`any` again, so the loose call sites the permissive-result note above exists
for still compile with no cast. What it costs is a JSON body that is not an
object — a top-level array, a bare string — which needs the type argument
(`fetchJson<Item[]>(url)`) it should be naming anyway.

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

`Promise`\<[`ToolFailure`](utils.md#toolfailure) \| `T`\>

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

`Promise`\<[`ToolFailure`](utils.md#toolfailure) \| `T`\>

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

`Promise`\<[`ToolFailure`](utils.md#toolfailure) \| `T`\>

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
