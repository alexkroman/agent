# llm

`@alexkroman1/aai/llm` subpath barrel — the model that drives the reply.

One factory, [llm](#llm), for every provider: it returns a serializable
DESCRIPTOR (`{ kind, options }`) that you hand to `agent({ llm })`. Import
from here rather than from `@ai-sdk/*` directly — the vendor SDK is loaded
host-side when the session starts, so the agent bundle stays free of its
eager env reads and other load-time side effects.

## Example

**Swap the LLM of an otherwise default agent**

```ts
import { agent } from "@alexkroman1/aai";
import { llm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  // `stt` and `tts` keep their AssemblyAI defaults.
  llm: llm({ provider: "anthropic", model: "claude-sonnet-5" }),
});
```

`agent({ llm })` also takes a bare model id — `llm: "zai/glm-4.6"` is
`provider: "gateway"`, and an id with no slash is `provider: "assemblyai"`.

**Credentials are never passed here.** The host resolver owns, per
provider, the env var its key is read from and reads it out of the agent's
own environment when the session starts — which is what keeps a descriptor
safe to serialize across the CLI → server → guest boundary. `apiKeyEnv`
repoints one descriptor at another variable; neither the names nor the base
URLs are published, since an author never types one.

`provider` is OPEN ([LlmProviderName](#llmprovidername)): a provider this release does
not know resolves as an OpenAI-compatible endpoint when the descriptor
carries a `baseUrl`. [AssemblyAIGatewayModel](index.md#assemblyaigatewaymodel) is open the same way —
the generated [KnownGatewayModel](#knowngatewaymodel) snapshot is autocomplete, not a
guard; the capability CATALOG behind it (which model streams, calls tools,
serves the EU) is on `@alexkroman1/aai/host-internal`, since its readers
are the studio's model selection and this repo's own gate.

## The descriptor type is on the ROOT barrel TOO

`LlmProvider` — what [llm](#llm) returns — is also exported from
`@alexkroman1/aai`, beside the other three stage types, so an agent
annotating two stages writes one import rather than two. It stays here as
well: this is where the factory that produces one lives.

## Functions

### llm()

```ts
function llm<P extends LlmProviderName>(options: LlmOptions<P>): LlmProvider;
```

Build an LLM descriptor for `agent({ llm })`, `subagent({ llm })` or
`ctx.generate({ llm })`.

The API key is resolved host-side from the agent's env, by a name the
resolver owns per provider (or by `apiKeyEnv`); a descriptor carries no
secret, so it stays safe to serialize across the CLI → server → guest
boundary.

#### Type Parameters

##### P

`P` *extends* [`LlmProviderName`](#llmprovidername)

#### Parameters

##### options

[`LlmOptions`](#llmoptions)\<`P`\>

#### Returns

[`LlmProvider`](index.md#llmprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { llm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  llm: llm({ provider: "assemblyai", model: "qwen3-next-80b-a3b" }),
});
```

A bare model id is the shorthand for the two gateways — `llm: "some-model"`
is `llm({ provider: "assemblyai", model: "some-model" })`, and
`llm: "creator/model"` is `provider: "gateway"`.

## Interfaces

### LlmOptions

Options for [llm](#llm).

`P` is inferred from `provider`, which is what narrows `model` to the
gateway's ids and `providerOptions` to [AssemblyAILlmProviderOptions](#assemblyaillmprovideroptions)
for `"assemblyai"`. On a provider with a native AI SDK client (`anthropic`,
`openai`, `google`, `mistral`, `xai`, `groq`, `gateway`) `providerOptions`
is that client's AI SDK `providerOptions` entry, validated against its typed
options. On an OpenAI-compatible one (`openrouter`, `cerebras`, or any
`baseUrl` provider) it is the vendor's own wire fields, merged verbatim into
the JSON request body — a field the SDK writes itself (`model`, `messages`,
`tools`, `stream`, a call setting such as `temperature`) wins a collision.

#### Extends

- [`ProviderCredentialOptions`](index.md#providercredentialoptions)

#### Type Parameters

##### P

`P` *extends* [`LlmProviderName`](#llmprovidername) = [`LlmProviderName`](#llmprovidername)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ProviderCredentialOptions`](index.md#providercredentialoptions).[`apiKeyEnv`](index.md#apikeyenv-1)

##### baseUrl?

```ts
readonly optional baseUrl?: string;
```

The endpoint to send requests to, replacing the provider's own. Must
include the version path — the client appends `/chat/completions`.

On a provider the runtime has no built-in entry for, this is what makes
the descriptor resolvable at all: it is dialled as an OpenAI-compatible
chat-completions API, keyed by `apiKeyEnv`.

##### model

```ts
readonly model: P extends "assemblyai" ? AssemblyAIGatewayModel : string;
```

The provider's own model id. `"gateway"` and `"openrouter"` address a
model as `"creator/model"`; every other provider takes its bare id.

Required: a third-party catalog is not this SDK's to default from, and an
id invented on its behalf fails at the first session. The AssemblyAI
default is [ASSEMBLYAI\_LLM\_DEFAULT\_MODEL](#assemblyai_llm_default_model), and an agent that omits
`llm` entirely runs it.

##### provider

```ts
readonly provider: P;
```

Which provider serves the model — see [KnownLlmProvider](#knownllmprovider).

##### providerOptions?

```ts
readonly optional providerOptions?: P extends "assemblyai" ? AssemblyAILlmProviderOptions : Readonly<Record<string, unknown>>;
```

Provider-specific settings — see [LlmOptions](#llmoptions).

## Type Aliases

### AssemblyAILlmProviderOptions

```ts
type AssemblyAILlmProviderOptions = {
  reasoningEffort?: AssemblyAIReasoningEffort;
  region?: "us" | "eu";
};
```

`providerOptions` for `provider: "assemblyai"`.

#### Properties

##### reasoningEffort?

```ts
readonly optional reasoningEffort?: AssemblyAIReasoningEffort;
```

Reasoning effort forwarded to the model as `reasoning_effort`.

Unset, no parameter is sent and the model runs on its own server-side
default — EXCEPT on the gateway models that reject a tool-carrying request
unless reasoning is off, where `llm()` fills `"none"`, because there
"unset" is a 500 on every turn. An explicit value is always honoured.

##### region?

```ts
readonly optional region?: "us" | "eu";
```

Gateway region. `"eu"` routes through the EU endpoint for data
residency — a subset of models, per the generated catalog's `eu` flag.
Defaults to `"us"`. A `baseUrl` on the same descriptor wins: naming an
endpoint is deliberate and must not be silently overwritten by the
residency shorthand.

***

### AssemblyAIReasoningEffort

```ts
type AssemblyAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";
```

Reasoning effort accepted by the gateway's GPT-5-family models, including
the two off switches: `"none"` (gpt-5.1 and later) and `"minimal"` (the
original `gpt-5`/`-mini`/`-nano`, whose lowest setting that is).

***

### KnownGatewayModel

```ts
type KnownGatewayModel = 
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-5-20251101"
  | "claude-opus-4-6"
  | "claude-opus-4-7"
  | "claude-opus-4-8"
  | "claude-opus-5"
  | "claude-sonnet-4-5-20250929"
  | "claude-sonnet-4-6"
  | "claude-sonnet-5"
  | "gemini-2.5-flash"
  | "gemini-2.5-flash-lite"
  | "gemini-2.5-pro"
  | "gemini-3.1-flash-lite"
  | "gemini-3.5-flash"
  | "gemini-3.5-flash-lite"
  | "gemini-3.6-flash"
  | "gemini-3.7-flash"
  | "gemini-3.8-flash"
  | "gemma-4-31b"
  | "gpt-4.1"
  | "gpt-5"
  | "gpt-5-mini"
  | "gpt-5-nano"
  | "gpt-5.1"
  | "gpt-5.2"
  | "gpt-5.5"
  | "gpt-5.6-luna"
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-6-astra"
  | "gpt-oss-120b"
  | "gpt-oss-20b"
  | "qwen3-32B"
  | "qwen3-next-80b-a3b"
  | "qwen3.5-4b-32k-fast";
```

An id the gateway advertised when this catalog was generated — the
autocomplete half of `AssemblyAIGatewayModel`, which also accepts any other
string. A snapshot of a service that ships models faster than this package
releases, so it is never a closed set: a model added upstream after this
release is still a legal id, and a regeneration that drops one breaks no
build.

***

### KnownLlmProvider

```ts
type KnownLlmProvider = 
  | "assemblyai"
  | "anthropic"
  | "cerebras"
  | "gateway"
  | "google"
  | "groq"
  | "mistral"
  | "openai"
  | "openrouter"
  | "xai";
```

The providers the runtime resolves with no registration — the autocomplete
half of [LlmProviderName](#llmprovidername).

- `"assemblyai"` — AssemblyAI's LLM Gateway, on the `ASSEMBLYAI_API_KEY`
  every agent already has. The default stage, and the one a bare model-id
  string (`llm: "some-model"`) routes to.
- `"gateway"` — the Vercel AI Gateway, `"creator/model"` ids; what an
  `llm: "creator/model"` string routes to.
- `"openrouter"` — OpenRouter, `"creator/model"` ids.
- `"anthropic"`, `"openai"`, `"google"`, `"mistral"`, `"xai"`, `"groq"`,
  `"cerebras"` — each vendor's own API and model ids.

***

### LlmProviderName

```ts
type LlmProviderName = 
  | KnownLlmProvider
  | string & {
};
```

An LLM provider name — one of [KnownLlmProvider](#knownllmprovider), or any other string.

Open on purpose: a provider this release does not know is reached with a
`baseUrl` (OpenAI-compatible) or a host's `registerLlmKind`, and a closed
union would refuse it at compile time for no reason the runtime shares.

## Variables

### ASSEMBLYAI\_LLM\_DEFAULT\_MODEL

```ts
const ASSEMBLYAI_LLM_DEFAULT_MODEL: AssemblyAIGatewayModel;
```

The gateway model to reach for when an agent has no opinion.

A default exists because the gateway rejects an unknown model id with a
400 that only appears at the first session — so "invent a plausible model
name" is a failure mode with no compile-time or deploy-time guard, and one
that a code-generating agent falls into readily.

**Changing this id changes more than the model.** Two things are keyed to
it, they disagree between model families, and getting either wrong is a
silent failure rather than a loud one. The default has moved four times, so
what follows is the RULE plus the measured matrix rather than a story about
each id:

1. **`TOOLS_REQUIRE_NO_REASONING` membership** decides whether the bare
   `llm({ provider: "assemblyai" })` carries an implicit `reasoningEffort: "none"`.
2. **`assemblyAIPipeline()`'s explicit effort** must be a value the id
   ACCEPTS. It is not a free tuning knob; a rejected value is a 400, and on
   the streaming path this SDK uses it arrives as a bare
   `500 {"message":"something went wrong"}` with the explanation stripped.

| id | in the set? | `"none"` | lowest accepted | reasoning tokens there |
| --- | --- | --- | --- | --- |
| `qwen3-next-80b-a3b` | no | **accepted** | `"none"` | **0** |
| `gpt-5.6-luna` / `-sol` / `-terra` | **yes** | REQUIRED for tools | `"none"` | 0 |
| `gemini-3.7-flash` | no | **400** | `"low"` | ~80 |
| `gemini-3.5-flash-lite` | no | **400** | `"minimal"` | 0 |

`gpt-5.6-luna` is INSIDE the set, so the bare factory fills `"none"` and
that fill is what makes a tool-carrying request work at all on it —
measured: `"none"` answers 200, omitting the parameter answers 400
non-streaming and a bare 500 streaming. `assemblyAIPipeline()`'s explicit
`"none"` therefore merely AGREES with the factory here, and it stays anyway,
because it is the only thing turning reasoning off under a default that sits
outside the set. **Keep it under every id.**

## This default is the only one MEASURED on answer quality

Four ids held it in one day; the benchmark settled it. All on tau2-bench
retail, matched per task against the same baseline run:

| default | reward | time-to-first-token (p50) |
| --- | --- | --- |
| **`gpt-5.6-luna`** | **0.463** (108 tasks) / 0.433 +/- 0.090 (0-9 x3) | 832ms |
| `gpt-5.6-sol` | 0.19 (16 sims) | 1156-1287ms |
| `gemini-3.7-flash` | not run | **2253ms** |
| `qwen3-next-80b-a3b` | **0.212** (33 matched tasks) | **664ms** |

The qwen row is the decisive one and the reason this constant came back:
over 33 tasks run against the identical set, luna scored 0.485 and qwen
0.212, with **11 regressions against 2 improvements** — McNemar two-sided
**p = 0.022**. Two unrelated replacement models both landed near 0.19-0.21,
so it is the model that moves this number, not one bad id.

**Time-to-first-token does not buy it back**, which is the finding worth
keeping: qwen is 3.4x faster to first token than the Gemini id and ~2x
faster than luna, and it still fails more than twice as often. The failures
are not latency-shaped — they are the lookup-recovery procedure in
`system-prompt-sections.ts` ("work this list in order") going unfollowed: on
a mis-heard name the smaller models re-ask for the same value, which that
list forbids as step one, instead of retrying a confusion or an identifier
they already hold. Every regression in that run was an
authentication-by-name task.

So a candidate default needs a tau2 run, not a latency measurement. Do not
move this id on price or first-token numbers alone.

## References

### AssemblyAIGatewayModel

Re-exports [AssemblyAIGatewayModel](index.md#assemblyaigatewaymodel)

***

### LlmProvider

Re-exports [LlmProvider](index.md#llmprovider)

***

### ProviderCredentialOptions

Re-exports [ProviderCredentialOptions](index.md#providercredentialoptions)
