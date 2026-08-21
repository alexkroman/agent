# llm

`@alexkroman1/aai/llm` subpath barrel.

Re-exports LLM provider factories. Users import from here instead of
`@ai-sdk/anthropic` directly so the agent bundle stays free of eager
env reads and other SDK side-effects.

Named re-exports rather than `export *`: the wildcard form needs a
`noReExportAll` suppression per line, and the escape-hatch ratchet only
moves down. Listing them also makes the public surface of this subpath
readable in one place — add new symbols here when a provider gains one.

## Interfaces

### AnthropicOptions

Options for [anthropic](#anthropic).

#### Properties

##### model

```ts
model: string;
```

Anthropic model id, e.g. `"claude-haiku-4-5"`.

***

### AssemblyAILlmOptions

Options for [assemblyAILlm](#assemblyaillm).

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default
(`ASSEMBLYAI_API_KEY`). Names a VARIABLE, not a key, so the descriptor
stays secret-free and safe to serialize.

For running one stage against a different account or cluster than the
others — AssemblyAI keys are environment-scoped, so a staging STT cluster
rejects a production key and vice versa, and a mixed setup needs both keys
live at once. The variable must be present in the agent's env (`.env` or
`aai secret put`), like any other credential.

##### gatewayUrl?

```ts
optional gatewayUrl?: string;
```

Gateway base URL, replacing [ASSEMBLYAI\_LLM\_GATEWAY\_URL](#assemblyai_llm_gateway_url). Must
include the version path (`https://llm-gateway.sandbox000.assemblyai-labs.com/v1`) —
the client appends `/chat/completions` and nothing else.

Takes precedence over [AssemblyAILlmOptions.region](#region), matching
`assemblyAIStt({ streamingUrl })`: naming an endpoint is deliberate and
must not be silently overwritten by the residency shorthand. Intended for
pre-release/staging clusters; a staging cluster generally issues its own
keys, so point every AssemblyAI stage at the same environment or the ones
left on production reject the key. Leave unset in production.

##### model?

```ts
optional model?: 
  | string & Record<never, never>
  | "qwen3-next-80b-a3b"
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-5-20251101"
  | "claude-opus-4-6"
  | "claude-opus-4-7"
  | "claude-opus-4-8"
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
  | "gpt-4.1"
  | "gpt-5"
  | "gpt-5-mini"
  | "gpt-5-nano"
  | "gpt-5.1"
  | "gpt-5.2"
  | "gpt-5.5"
  | "gpt-5.6-luna"
  | "gpt-5.6-terra"
  | "gpt-oss-120b"
  | "gpt-oss-20b"
  | "kimi-k2.5"
  | "qwen3-32B"
  | "qwen3.5-4b-32k-experimental";
```

Gateway model id — see [ASSEMBLYAI\_GATEWAY\_MODELS](#assemblyai_gateway_models) for the catalog,
which is generated from the gateway's own `/v1/models` and records which
models can stream, call tools, and serve the EU region.

Typed against that catalog so a name the gateway does not carry is caught
where it is written, rather than as a 400 at the first session. A plain
string is still accepted, because the catalog is a snapshot of a service
that adds models faster than this package releases.

Note two listed models (`gpt-oss-20b`, `gpt-oss-120b`) cannot stream, so
they cannot drive a voice pipeline at all.

Defaults to [ASSEMBLYAI\_LLM\_DEFAULT\_MODEL](#assemblyai_llm_default_model).

##### reasoningEffort?

```ts
optional reasoningEffort?: AssemblyAIReasoningEffort;
```

Reasoning effort forwarded to the model as `reasoning_effort`.

Unset, no `reasoning_effort` parameter is sent at all — the model runs
on its own server-side default. Set `"none"` (gpt-5.1 and later) or
`"minimal"` (the original `gpt-5`/`-mini`/`-nano`) to turn reasoning
off, e.g. when a voice turn's time-to-first-token matters more than
thinking depth.

The GPT-5 family is not the only one that accepts it — `qwen3-next-80b-a3b`
is a hybrid-thinking model and takes it too (measured 2026-08-06 against
the live gateway: `"none"` and `"low"` both return a normal tool-calling
completion, streaming included). Models that do not accept it reject a
bogus value with a 400 naming the ones they do.

**Exception: on the `gpt-5.6` models unset is not a usable state, so the
factory fills in `"none"`** — they reject a tool-carrying request at any
other effort, and streaming reports that as a bare 500. Setting a
non-`none` effort on one of them is honoured, and breaks tool calls. See
`TOOLS_REQUIRE_NO_REASONING`. The default model
([ASSEMBLYAI\_LLM\_DEFAULT\_MODEL](#assemblyai_llm_default_model)) is NOT one of them, so the rule
above is the live path — a bare `assemblyAILlm()` sends no parameter — and
this exception applies only once a `gpt-5.6` id is named.

##### region?

```ts
optional region?: "us" | "eu";
```

Gateway region. `"eu"` routes through the EU endpoint for data
residency — six models at time of writing, per the `eu` flag in
[ASSEMBLYAI\_GATEWAY\_MODELS](#assemblyai_gateway_models). Defaults to `"us"`.

***

### GatewayOptions

Options for [gateway](#gateway).

#### Properties

##### model

```ts
model: string;
```

Gateway model id in `"creator/model"` form, e.g. `"zai/glm-4.6"`,
`"anthropic/claude-sonnet-4-5"`, `"openai/gpt-4.1"`. See
https://vercel.com/ai-gateway/models for the full list.

***

### GoogleOptions

Options for [google](#google).

#### Properties

##### model

```ts
model: string;
```

Google Gemini model id, e.g. `"gemini-2.0-flash"`.

***

### GroqOptions

Options for [groq](#groq).

#### Properties

##### model

```ts
model: string;
```

Groq model id, e.g. `"llama-3.3-70b-versatile"`.

***

### MistralOptions

Options for [mistral](#mistral).

#### Properties

##### model

```ts
model: string;
```

Mistral model id, e.g. `"mistral-large-latest"`.

***

### OpenAIOptions

Options for [openai](#openai).

#### Properties

##### model

```ts
model: string;
```

OpenAI model id, e.g. `"gpt-4o"`, `"gpt-4o-mini"`.

***

### OpenRouterOptions

Options for [openrouter](#openrouter).

#### Properties

##### model

```ts
model: string;
```

OpenRouter model id in `"creator/model"` form, e.g.
`"anthropic/claude-sonnet-4.5"`, `"openai/gpt-4.1"`,
`"meta-llama/llama-3.3-70b-instruct"`. See
https://openrouter.ai/models for the full list.

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

### XaiOptions

Options for [xai](#xai).

#### Properties

##### model

```ts
model: string;
```

xAI Grok model id, e.g. `"grok-2-1212"`.

## Type Aliases

### AnthropicProvider

```ts
type AnthropicProvider = LlmProvider & {
  kind: typeof ANTHROPIC_KIND;
  options: AnthropicOptions;
};
```

Descriptor returned by [anthropic](#anthropic).

#### Type Declaration

##### kind

```ts
readonly kind: typeof ANTHROPIC_KIND;
```

##### options

```ts
readonly options: AnthropicOptions;
```

***

### AssemblyAIGatewayModel

```ts
type AssemblyAIGatewayModel = keyof typeof ASSEMBLYAI_GATEWAY_MODELS;
```

An id the gateway advertises.

***

### AssemblyAILlmProvider

```ts
type AssemblyAILlmProvider = LlmProvider & {
  kind: typeof ASSEMBLYAI_LLM_KIND;
  options: AssemblyAILlmOptions & {
     model: string;
  };
};
```

Descriptor returned by [assemblyAILlm](#assemblyaillm).

#### Type Declaration

##### kind

```ts
readonly kind: typeof ASSEMBLYAI_LLM_KIND;
```

##### options

```ts
readonly options: AssemblyAILlmOptions & {
  model: string;
};
```

###### Type Declaration

###### model

```ts
model: string;
```

***

### AssemblyAIReasoningEffort

```ts
type AssemblyAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";
```

Reasoning effort accepted by the gateway's GPT-5-family models, including
the two off switches: `"none"` (gpt-5.1 and later) and `"minimal"` (the
original `gpt-5`/`-mini`/`-nano`, whose lowest setting that is).

***

### GatewayModelInfo

```ts
type GatewayModelInfo = {
  context: number;
  eu: boolean;
  live: boolean;
  stream: boolean;
  tools: boolean;
};
```

The AssemblyAI LLM Gateway model catalog.

GENERATED — run `node scripts/gen-gateway-models.mjs --write` to refresh,
and `pnpm check:gateway-models` to verify. Do not hand-edit: every
hand-maintained version of this list was wrong. One carried a deprecated
model and one that had never existed while missing nine real ones; another
inferred EU availability from id prefixes and produced four models the EU
endpoint does not serve.

Capabilities come from the endpoint's `supported_parameters` and are not
decoration:

- `stream: false` cannot be used for a voice pipeline or a studio turn at
  all — both stream. Two listed models are in this category.
- `tools: false` cannot run an agent that has tools.

A model being listed here means the gateway advertises it, which is a
weaker claim than it working: `kimi-k2.5` is advertised and answers 410.
That is why the check script probes rather than trusting this file.

#### Properties

##### context

```ts
readonly context: number;
```

Context window in tokens, as the gateway reports it.

##### eu

```ts
readonly eu: boolean;
```

Served by the EU endpoint (`llm-gateway.eu.assemblyai.com`).

##### live

```ts
readonly live: boolean;
```

Answered a minimal request, as this SDK sends one, when generated.
`false` means the gateway advertises the model and will not run it for
us: `kimi-k2.5` answers 410 (deprecated), `gemini-3.6-flash` answers
400 (needs a `model_region` parameter nothing here sends).

##### stream

```ts
readonly stream: boolean;
```

Supports `stream: true` — required for voice pipelines and studio chat.

##### tools

```ts
readonly tools: boolean;
```

Accepts a `tools` array — required for any agent with tools.

***

### GatewayProvider

```ts
type GatewayProvider = LlmProvider & {
  kind: typeof GATEWAY_KIND;
  options: GatewayOptions;
};
```

Descriptor returned by [gateway](#gateway).

#### Type Declaration

##### kind

```ts
readonly kind: typeof GATEWAY_KIND;
```

##### options

```ts
readonly options: GatewayOptions;
```

***

### GoogleProvider

```ts
type GoogleProvider = LlmProvider & {
  kind: typeof GOOGLE_KIND;
  options: GoogleOptions;
};
```

Descriptor returned by [google](#google).

#### Type Declaration

##### kind

```ts
readonly kind: typeof GOOGLE_KIND;
```

##### options

```ts
readonly options: GoogleOptions;
```

***

### GroqProvider

```ts
type GroqProvider = LlmProvider & {
  kind: typeof GROQ_KIND;
  options: GroqOptions;
};
```

Descriptor returned by [groq](#groq).

#### Type Declaration

##### kind

```ts
readonly kind: typeof GROQ_KIND;
```

##### options

```ts
readonly options: GroqOptions;
```

***

### LlmProvider

```ts
type LlmProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  __stage?: "llm";
};
```

Descriptor for an LLM provider. Returned by factories like
`anthropic(...)` from `@alexkroman1/aai/llm`.

#### Type Declaration

##### \_\_stage?

```ts
readonly optional __stage?: "llm";
```

Compile-time stage tag; never present at runtime.

***

### MistralProvider

```ts
type MistralProvider = LlmProvider & {
  kind: typeof MISTRAL_KIND;
  options: MistralOptions;
};
```

Descriptor returned by [mistral](#mistral).

#### Type Declaration

##### kind

```ts
readonly kind: typeof MISTRAL_KIND;
```

##### options

```ts
readonly options: MistralOptions;
```

***

### OpenAIProvider

```ts
type OpenAIProvider = LlmProvider & {
  kind: typeof OPENAI_KIND;
  options: OpenAIOptions;
};
```

Descriptor returned by [openai](#openai).

#### Type Declaration

##### kind

```ts
readonly kind: typeof OPENAI_KIND;
```

##### options

```ts
readonly options: OpenAIOptions;
```

***

### OpenRouterProvider

```ts
type OpenRouterProvider = LlmProvider & {
  kind: typeof OPENROUTER_KIND;
  options: OpenRouterOptions;
};
```

Descriptor returned by [openrouter](#openrouter).

#### Type Declaration

##### kind

```ts
readonly kind: typeof OPENROUTER_KIND;
```

##### options

```ts
readonly options: OpenRouterOptions;
```

***

### XaiProvider

```ts
type XaiProvider = LlmProvider & {
  kind: typeof XAI_KIND;
  options: XaiOptions;
};
```

Descriptor returned by [xai](#xai).

#### Type Declaration

##### kind

```ts
readonly kind: typeof XAI_KIND;
```

##### options

```ts
readonly options: XaiOptions;
```

## Variables

### ANTHROPIC\_API\_KEY\_ENV

```ts
const ANTHROPIC_API_KEY_ENV: "ANTHROPIC_API_KEY" = "ANTHROPIC_API_KEY";
```

Agent-env variable holding the Anthropic API key.

***

### ANTHROPIC\_KIND

```ts
const ANTHROPIC_KIND: "anthropic";
```

***

### ASSEMBLYAI\_GATEWAY\_MODELS

```ts
const ASSEMBLYAI_GATEWAY_MODELS: {
  claude-haiku-4-5-20251001: {
     context: 200000;
     eu: true;
     live: true;
     stream: true;
     tools: true;
  };
  claude-opus-4-5-20251101: {
     context: 200000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  claude-opus-4-6: {
     context: 200000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  claude-opus-4-7: {
     context: 1000000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  claude-opus-4-8: {
     context: 1000000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  claude-sonnet-4-5-20250929: {
     context: 200000;
     eu: true;
     live: true;
     stream: true;
     tools: true;
  };
  claude-sonnet-4-6: {
     context: 200000;
     eu: true;
     live: true;
     stream: true;
     tools: true;
  };
  claude-sonnet-5: {
     context: 200000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gemini-2.5-flash: {
     context: 1048576;
     eu: true;
     live: true;
     stream: true;
     tools: true;
  };
  gemini-2.5-flash-lite: {
     context: 1048576;
     eu: true;
     live: true;
     stream: true;
     tools: true;
  };
  gemini-2.5-pro: {
     context: 200000;
     eu: true;
     live: true;
     stream: true;
     tools: true;
  };
  gemini-3.1-flash-lite: {
     context: 1048575;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gemini-3.5-flash: {
     context: 1048575;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gemini-3.5-flash-lite: {
     context: 1048575;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gemini-3.6-flash: {
     context: 1048575;
     eu: false;
     live: false;
     stream: true;
     tools: true;
  };
  gpt-4.1: {
     context: 1047576;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gpt-5: {
     context: 400000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gpt-5-mini: {
     context: 400000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gpt-5-nano: {
     context: 400000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gpt-5.1: {
     context: 400000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gpt-5.2: {
     context: 400000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gpt-5.5: {
     context: 272000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gpt-5.6-luna: {
     context: 270000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gpt-5.6-terra: {
     context: 270000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  gpt-oss-120b: {
     context: 131072;
     eu: false;
     live: true;
     stream: false;
     tools: true;
  };
  gpt-oss-20b: {
     context: 131072;
     eu: false;
     live: true;
     stream: false;
     tools: true;
  };
  kimi-k2.5: {
     context: 200000;
     eu: false;
     live: false;
     stream: true;
     tools: true;
  };
  qwen3-32B: {
     context: 200000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  qwen3-next-80b-a3b: {
     context: 200000;
     eu: false;
     live: true;
     stream: true;
     tools: true;
  };
  qwen3.5-4b-32k-experimental: {
     context: 32768;
     eu: false;
     live: true;
     stream: true;
     tools: false;
  };
};
```

#### Type Declaration

##### claude-haiku-4-5-20251001

```ts
readonly claude-haiku-4-5-20251001: {
  context: 200000;
  eu: true;
  live: true;
  stream: true;
  tools: true;
};
```

###### claude-haiku-4-5-20251001.context

```ts
readonly context: 200000;
```

###### claude-haiku-4-5-20251001.eu

```ts
readonly eu: true;
```

###### claude-haiku-4-5-20251001.live

```ts
readonly live: true;
```

###### claude-haiku-4-5-20251001.stream

```ts
readonly stream: true;
```

###### claude-haiku-4-5-20251001.tools

```ts
readonly tools: true;
```

##### claude-opus-4-5-20251101

```ts
readonly claude-opus-4-5-20251101: {
  context: 200000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### claude-opus-4-5-20251101.context

```ts
readonly context: 200000;
```

###### claude-opus-4-5-20251101.eu

```ts
readonly eu: false;
```

###### claude-opus-4-5-20251101.live

```ts
readonly live: true;
```

###### claude-opus-4-5-20251101.stream

```ts
readonly stream: true;
```

###### claude-opus-4-5-20251101.tools

```ts
readonly tools: true;
```

##### claude-opus-4-6

```ts
readonly claude-opus-4-6: {
  context: 200000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### claude-opus-4-6.context

```ts
readonly context: 200000;
```

###### claude-opus-4-6.eu

```ts
readonly eu: false;
```

###### claude-opus-4-6.live

```ts
readonly live: true;
```

###### claude-opus-4-6.stream

```ts
readonly stream: true;
```

###### claude-opus-4-6.tools

```ts
readonly tools: true;
```

##### claude-opus-4-7

```ts
readonly claude-opus-4-7: {
  context: 1000000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### claude-opus-4-7.context

```ts
readonly context: 1000000;
```

###### claude-opus-4-7.eu

```ts
readonly eu: false;
```

###### claude-opus-4-7.live

```ts
readonly live: true;
```

###### claude-opus-4-7.stream

```ts
readonly stream: true;
```

###### claude-opus-4-7.tools

```ts
readonly tools: true;
```

##### claude-opus-4-8

```ts
readonly claude-opus-4-8: {
  context: 1000000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### claude-opus-4-8.context

```ts
readonly context: 1000000;
```

###### claude-opus-4-8.eu

```ts
readonly eu: false;
```

###### claude-opus-4-8.live

```ts
readonly live: true;
```

###### claude-opus-4-8.stream

```ts
readonly stream: true;
```

###### claude-opus-4-8.tools

```ts
readonly tools: true;
```

##### claude-sonnet-4-5-20250929

```ts
readonly claude-sonnet-4-5-20250929: {
  context: 200000;
  eu: true;
  live: true;
  stream: true;
  tools: true;
};
```

###### claude-sonnet-4-5-20250929.context

```ts
readonly context: 200000;
```

###### claude-sonnet-4-5-20250929.eu

```ts
readonly eu: true;
```

###### claude-sonnet-4-5-20250929.live

```ts
readonly live: true;
```

###### claude-sonnet-4-5-20250929.stream

```ts
readonly stream: true;
```

###### claude-sonnet-4-5-20250929.tools

```ts
readonly tools: true;
```

##### claude-sonnet-4-6

```ts
readonly claude-sonnet-4-6: {
  context: 200000;
  eu: true;
  live: true;
  stream: true;
  tools: true;
};
```

###### claude-sonnet-4-6.context

```ts
readonly context: 200000;
```

###### claude-sonnet-4-6.eu

```ts
readonly eu: true;
```

###### claude-sonnet-4-6.live

```ts
readonly live: true;
```

###### claude-sonnet-4-6.stream

```ts
readonly stream: true;
```

###### claude-sonnet-4-6.tools

```ts
readonly tools: true;
```

##### claude-sonnet-5

```ts
readonly claude-sonnet-5: {
  context: 200000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### claude-sonnet-5.context

```ts
readonly context: 200000;
```

###### claude-sonnet-5.eu

```ts
readonly eu: false;
```

###### claude-sonnet-5.live

```ts
readonly live: true;
```

###### claude-sonnet-5.stream

```ts
readonly stream: true;
```

###### claude-sonnet-5.tools

```ts
readonly tools: true;
```

###### gemini-2.5-flash

```ts
readonly gemini-2.5-flash: {
  context: 1048576;
  eu: true;
  live: true;
  stream: true;
  tools: true;
};
```

###### gemini-2.5-flash.context

```ts
readonly context: 1048576;
```

###### gemini-2.5-flash.eu

```ts
readonly eu: true;
```

###### gemini-2.5-flash.live

```ts
readonly live: true;
```

###### gemini-2.5-flash.stream

```ts
readonly stream: true;
```

###### gemini-2.5-flash.tools

```ts
readonly tools: true;
```

###### gemini-2.5-flash-lite

```ts
readonly gemini-2.5-flash-lite: {
  context: 1048576;
  eu: true;
  live: true;
  stream: true;
  tools: true;
};
```

###### gemini-2.5-flash-lite.context

```ts
readonly context: 1048576;
```

###### gemini-2.5-flash-lite.eu

```ts
readonly eu: true;
```

###### gemini-2.5-flash-lite.live

```ts
readonly live: true;
```

###### gemini-2.5-flash-lite.stream

```ts
readonly stream: true;
```

###### gemini-2.5-flash-lite.tools

```ts
readonly tools: true;
```

###### gemini-2.5-pro

```ts
readonly gemini-2.5-pro: {
  context: 200000;
  eu: true;
  live: true;
  stream: true;
  tools: true;
};
```

###### gemini-2.5-pro.context

```ts
readonly context: 200000;
```

###### gemini-2.5-pro.eu

```ts
readonly eu: true;
```

###### gemini-2.5-pro.live

```ts
readonly live: true;
```

###### gemini-2.5-pro.stream

```ts
readonly stream: true;
```

###### gemini-2.5-pro.tools

```ts
readonly tools: true;
```

###### gemini-3.1-flash-lite

```ts
readonly gemini-3.1-flash-lite: {
  context: 1048575;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gemini-3.1-flash-lite.context

```ts
readonly context: 1048575;
```

###### gemini-3.1-flash-lite.eu

```ts
readonly eu: false;
```

###### gemini-3.1-flash-lite.live

```ts
readonly live: true;
```

###### gemini-3.1-flash-lite.stream

```ts
readonly stream: true;
```

###### gemini-3.1-flash-lite.tools

```ts
readonly tools: true;
```

###### gemini-3.5-flash

```ts
readonly gemini-3.5-flash: {
  context: 1048575;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gemini-3.5-flash.context

```ts
readonly context: 1048575;
```

###### gemini-3.5-flash.eu

```ts
readonly eu: false;
```

###### gemini-3.5-flash.live

```ts
readonly live: true;
```

###### gemini-3.5-flash.stream

```ts
readonly stream: true;
```

###### gemini-3.5-flash.tools

```ts
readonly tools: true;
```

###### gemini-3.5-flash-lite

```ts
readonly gemini-3.5-flash-lite: {
  context: 1048575;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gemini-3.5-flash-lite.context

```ts
readonly context: 1048575;
```

###### gemini-3.5-flash-lite.eu

```ts
readonly eu: false;
```

###### gemini-3.5-flash-lite.live

```ts
readonly live: true;
```

###### gemini-3.5-flash-lite.stream

```ts
readonly stream: true;
```

###### gemini-3.5-flash-lite.tools

```ts
readonly tools: true;
```

###### gemini-3.6-flash

```ts
readonly gemini-3.6-flash: {
  context: 1048575;
  eu: false;
  live: false;
  stream: true;
  tools: true;
};
```

###### gemini-3.6-flash.context

```ts
readonly context: 1048575;
```

###### gemini-3.6-flash.eu

```ts
readonly eu: false;
```

###### gemini-3.6-flash.live

```ts
readonly live: false;
```

###### gemini-3.6-flash.stream

```ts
readonly stream: true;
```

###### gemini-3.6-flash.tools

```ts
readonly tools: true;
```

###### gpt-4.1

```ts
readonly gpt-4.1: {
  context: 1047576;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gpt-4.1.context

```ts
readonly context: 1047576;
```

###### gpt-4.1.eu

```ts
readonly eu: false;
```

###### gpt-4.1.live

```ts
readonly live: true;
```

###### gpt-4.1.stream

```ts
readonly stream: true;
```

###### gpt-4.1.tools

```ts
readonly tools: true;
```

##### gpt-5

```ts
readonly gpt-5: {
  context: 400000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gpt-5.context

```ts
readonly context: 400000;
```

###### gpt-5.eu

```ts
readonly eu: false;
```

###### gpt-5.live

```ts
readonly live: true;
```

###### gpt-5.stream

```ts
readonly stream: true;
```

###### gpt-5.tools

```ts
readonly tools: true;
```

##### gpt-5-mini

```ts
readonly gpt-5-mini: {
  context: 400000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gpt-5-mini.context

```ts
readonly context: 400000;
```

###### gpt-5-mini.eu

```ts
readonly eu: false;
```

###### gpt-5-mini.live

```ts
readonly live: true;
```

###### gpt-5-mini.stream

```ts
readonly stream: true;
```

###### gpt-5-mini.tools

```ts
readonly tools: true;
```

##### gpt-5-nano

```ts
readonly gpt-5-nano: {
  context: 400000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gpt-5-nano.context

```ts
readonly context: 400000;
```

###### gpt-5-nano.eu

```ts
readonly eu: false;
```

###### gpt-5-nano.live

```ts
readonly live: true;
```

###### gpt-5-nano.stream

```ts
readonly stream: true;
```

###### gpt-5-nano.tools

```ts
readonly tools: true;
```

###### gpt-5.1

```ts
readonly gpt-5.1: {
  context: 400000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gpt-5.1.context

```ts
readonly context: 400000;
```

###### gpt-5.1.eu

```ts
readonly eu: false;
```

###### gpt-5.1.live

```ts
readonly live: true;
```

###### gpt-5.1.stream

```ts
readonly stream: true;
```

###### gpt-5.1.tools

```ts
readonly tools: true;
```

###### gpt-5.2

```ts
readonly gpt-5.2: {
  context: 400000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gpt-5.2.context

```ts
readonly context: 400000;
```

###### gpt-5.2.eu

```ts
readonly eu: false;
```

###### gpt-5.2.live

```ts
readonly live: true;
```

###### gpt-5.2.stream

```ts
readonly stream: true;
```

###### gpt-5.2.tools

```ts
readonly tools: true;
```

###### gpt-5.5

```ts
readonly gpt-5.5: {
  context: 272000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gpt-5.5.context

```ts
readonly context: 272000;
```

###### gpt-5.5.eu

```ts
readonly eu: false;
```

###### gpt-5.5.live

```ts
readonly live: true;
```

###### gpt-5.5.stream

```ts
readonly stream: true;
```

###### gpt-5.5.tools

```ts
readonly tools: true;
```

###### gpt-5.6-luna

```ts
readonly gpt-5.6-luna: {
  context: 270000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gpt-5.6-luna.context

```ts
readonly context: 270000;
```

###### gpt-5.6-luna.eu

```ts
readonly eu: false;
```

###### gpt-5.6-luna.live

```ts
readonly live: true;
```

###### gpt-5.6-luna.stream

```ts
readonly stream: true;
```

###### gpt-5.6-luna.tools

```ts
readonly tools: true;
```

###### gpt-5.6-terra

```ts
readonly gpt-5.6-terra: {
  context: 270000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### gpt-5.6-terra.context

```ts
readonly context: 270000;
```

###### gpt-5.6-terra.eu

```ts
readonly eu: false;
```

###### gpt-5.6-terra.live

```ts
readonly live: true;
```

###### gpt-5.6-terra.stream

```ts
readonly stream: true;
```

###### gpt-5.6-terra.tools

```ts
readonly tools: true;
```

##### gpt-oss-120b

```ts
readonly gpt-oss-120b: {
  context: 131072;
  eu: false;
  live: true;
  stream: false;
  tools: true;
};
```

###### gpt-oss-120b.context

```ts
readonly context: 131072;
```

###### gpt-oss-120b.eu

```ts
readonly eu: false;
```

###### gpt-oss-120b.live

```ts
readonly live: true;
```

###### gpt-oss-120b.stream

```ts
readonly stream: false;
```

###### gpt-oss-120b.tools

```ts
readonly tools: true;
```

##### gpt-oss-20b

```ts
readonly gpt-oss-20b: {
  context: 131072;
  eu: false;
  live: true;
  stream: false;
  tools: true;
};
```

###### gpt-oss-20b.context

```ts
readonly context: 131072;
```

###### gpt-oss-20b.eu

```ts
readonly eu: false;
```

###### gpt-oss-20b.live

```ts
readonly live: true;
```

###### gpt-oss-20b.stream

```ts
readonly stream: false;
```

###### gpt-oss-20b.tools

```ts
readonly tools: true;
```

###### kimi-k2.5

```ts
readonly kimi-k2.5: {
  context: 200000;
  eu: false;
  live: false;
  stream: true;
  tools: true;
};
```

###### kimi-k2.5.context

```ts
readonly context: 200000;
```

###### kimi-k2.5.eu

```ts
readonly eu: false;
```

###### kimi-k2.5.live

```ts
readonly live: false;
```

###### kimi-k2.5.stream

```ts
readonly stream: true;
```

###### kimi-k2.5.tools

```ts
readonly tools: true;
```

##### qwen3-32B

```ts
readonly qwen3-32B: {
  context: 200000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### qwen3-32B.context

```ts
readonly context: 200000;
```

###### qwen3-32B.eu

```ts
readonly eu: false;
```

###### qwen3-32B.live

```ts
readonly live: true;
```

###### qwen3-32B.stream

```ts
readonly stream: true;
```

###### qwen3-32B.tools

```ts
readonly tools: true;
```

##### qwen3-next-80b-a3b

```ts
readonly qwen3-next-80b-a3b: {
  context: 200000;
  eu: false;
  live: true;
  stream: true;
  tools: true;
};
```

###### qwen3-next-80b-a3b.context

```ts
readonly context: 200000;
```

###### qwen3-next-80b-a3b.eu

```ts
readonly eu: false;
```

###### qwen3-next-80b-a3b.live

```ts
readonly live: true;
```

###### qwen3-next-80b-a3b.stream

```ts
readonly stream: true;
```

###### qwen3-next-80b-a3b.tools

```ts
readonly tools: true;
```

###### qwen3.5-4b-32k-experimental

```ts
readonly qwen3.5-4b-32k-experimental: {
  context: 32768;
  eu: false;
  live: true;
  stream: true;
  tools: false;
};
```

###### qwen3.5-4b-32k-experimental.context

```ts
readonly context: 32768;
```

###### qwen3.5-4b-32k-experimental.eu

```ts
readonly eu: false;
```

###### qwen3.5-4b-32k-experimental.live

```ts
readonly live: true;
```

###### qwen3.5-4b-32k-experimental.stream

```ts
readonly stream: true;
```

###### qwen3.5-4b-32k-experimental.tools

```ts
readonly tools: false;
```

***

### ASSEMBLYAI\_LLM\_API\_KEY\_ENV

```ts
const ASSEMBLYAI_LLM_API_KEY_ENV: "ASSEMBLYAI_API_KEY" = "ASSEMBLYAI_API_KEY";
```

Agent-env variable holding the AssemblyAI API key (same key as AssemblyAI STT).

***

### ASSEMBLYAI\_LLM\_DEFAULT\_MODEL

```ts
const ASSEMBLYAI_LLM_DEFAULT_MODEL: "qwen3-next-80b-a3b" = "qwen3-next-80b-a3b";
```

The gateway model to reach for when an agent has no opinion.

A default exists because the gateway rejects an unknown model id with a
400 that only appears at the first session — so "invent a plausible model
name" is a failure mode with no compile-time or deploy-time guard, and one
that a code-generating agent falls into readily.

**Changing this id changes more than the model**, because
`TOOLS_REQUIRE_NO_REASONING` is keyed by model id: a default inside
that set makes the bare `assemblyAILlm()` carry an implicit
`reasoningEffort: "none"`, and one outside it carry none at all.
`qwen3-next-80b-a3b` is OUTSIDE the set — it accepts a tool-carrying request
at any effort, including its own server-side default — so a bare
`assemblyAILlm()`, every unset pipeline stage, and the `llm: "<id>"` string
shorthand now send no `reasoning_effort` at all. Move the default back to a
`gpt-5.6` id and that fill becomes load-bearing again: without it the
descriptor 500s on every tool-calling turn.

Only the raw factory is affected either way: `assemblyAIPipeline()` passes
`"none"` explicitly, for latency rather than for that constraint, so the
pipeline behaves identically whichever side of the set the default sits on.

***

### ASSEMBLYAI\_LLM\_GATEWAY\_EU\_URL

```ts
const ASSEMBLYAI_LLM_GATEWAY_EU_URL: "https://llm-gateway.eu.assemblyai.com/v1" = "https://llm-gateway.eu.assemblyai.com/v1";
```

EU LLM Gateway endpoint — keeps data within the European Union.

***

### ASSEMBLYAI\_LLM\_GATEWAY\_URL

```ts
const ASSEMBLYAI_LLM_GATEWAY_URL: "https://llm-gateway.assemblyai.com/v1" = "https://llm-gateway.assemblyai.com/v1";
```

US (default) LLM Gateway endpoint.

***

### ASSEMBLYAI\_LLM\_KIND

```ts
const ASSEMBLYAI_LLM_KIND: "assemblyai";
```

Kind tag recognised by the host-side resolver.

***

### GATEWAY\_API\_KEY\_ENV

```ts
const GATEWAY_API_KEY_ENV: "AI_GATEWAY_API_KEY" = "AI_GATEWAY_API_KEY";
```

Agent-env variable holding the Vercel AI Gateway API key.

***

### GATEWAY\_KIND

```ts
const GATEWAY_KIND: "gateway";
```

***

### GOOGLE\_API\_KEY\_ENV

```ts
const GOOGLE_API_KEY_ENV: "GOOGLE_GENERATIVE_AI_API_KEY" = "GOOGLE_GENERATIVE_AI_API_KEY";
```

Agent-env variable holding the Google Generative AI API key.

***

### GOOGLE\_KIND

```ts
const GOOGLE_KIND: "google";
```

***

### GROQ\_API\_KEY\_ENV

```ts
const GROQ_API_KEY_ENV: "GROQ_API_KEY" = "GROQ_API_KEY";
```

Agent-env variable holding the Groq API key.

***

### GROQ\_KIND

```ts
const GROQ_KIND: "groq";
```

***

### MISTRAL\_API\_KEY\_ENV

```ts
const MISTRAL_API_KEY_ENV: "MISTRAL_API_KEY" = "MISTRAL_API_KEY";
```

Agent-env variable holding the Mistral API key.

***

### MISTRAL\_KIND

```ts
const MISTRAL_KIND: "mistral";
```

***

### OPENAI\_API\_KEY\_ENV

```ts
const OPENAI_API_KEY_ENV: "OPENAI_API_KEY" = "OPENAI_API_KEY";
```

Agent-env variable holding the OpenAI API key (shared with the OpenAI Realtime S2S provider).

***

### OPENAI\_KIND

```ts
const OPENAI_KIND: "openai";
```

***

### OPENROUTER\_API\_KEY\_ENV

```ts
const OPENROUTER_API_KEY_ENV: "OPENROUTER_API_KEY" = "OPENROUTER_API_KEY";
```

Agent-env variable holding the OpenRouter API key.

***

### OPENROUTER\_BASE\_URL

```ts
const OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1" = "https://openrouter.ai/api/v1";
```

OpenRouter's OpenAI-compatible API endpoint.

***

### OPENROUTER\_KIND

```ts
const OPENROUTER_KIND: "openrouter";
```

***

### XAI\_API\_KEY\_ENV

```ts
const XAI_API_KEY_ENV: "XAI_API_KEY" = "XAI_API_KEY";
```

Agent-env variable holding the xAI API key.

***

### XAI\_KIND

```ts
const XAI_KIND: "xai";
```

## Functions

### anthropic()

```ts
function anthropic(opts: AnthropicOptions): AnthropicProvider;
```

Build an Anthropic (Claude) LLM descriptor for pipeline mode. The API key
is resolved host-side from the agent's env (`ANTHROPIC_API_KEY`).

#### Parameters

##### opts

[`AnthropicOptions`](#anthropicoptions)

#### Returns

[`AnthropicProvider`](#anthropicprovider)

***

### assemblyAILlm()

```ts
function assemblyAILlm(opts?: AssemblyAILlmOptions): AssemblyAILlmProvider;
```

Build an AssemblyAI LLM Gateway descriptor.

The API key is resolved host-side from the agent's env
(`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

Named `assemblyAILlm` (not `assemblyAI`) so the STT
(`assemblyAIStt`), LLM, and TTS (`assemblyAITts`) factories can be
imported side by side without aliasing.

#### Parameters

##### opts?

[`AssemblyAILlmOptions`](#assemblyaillmoptions)

#### Returns

[`AssemblyAILlmProvider`](#assemblyaillmprovider)

***

### gateway()

```ts
function gateway(opts: GatewayOptions): GatewayProvider;
```

Build a Vercel AI Gateway descriptor.

The API key is resolved host-side from the agent's env
(`AI_GATEWAY_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

#### Parameters

##### opts

[`GatewayOptions`](#gatewayoptions)

#### Returns

[`GatewayProvider`](#gatewayprovider)

***

### gatewayModelIds()

```ts
function gatewayModelIds(opts?: {
  eu?: boolean;
}): (
  | "qwen3-next-80b-a3b"
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-5-20251101"
  | "claude-opus-4-6"
  | "claude-opus-4-7"
  | "claude-opus-4-8"
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
  | "gpt-4.1"
  | "gpt-5"
  | "gpt-5-mini"
  | "gpt-5-nano"
  | "gpt-5.1"
  | "gpt-5.2"
  | "gpt-5.5"
  | "gpt-5.6-luna"
  | "gpt-5.6-terra"
  | "gpt-oss-120b"
  | "gpt-oss-20b"
  | "kimi-k2.5"
  | "qwen3-32B"
  | "qwen3.5-4b-32k-experimental")[];
```

Ids usable for a streaming, tool-calling agent — the only shape this SDK
runs — and that actually answer. Deriving it beats another hand-kept list:
a model that is deprecated or loses `stream` upstream drops out on the
next regeneration instead of waiting to be noticed.

#### Parameters

##### opts?

###### eu?

`boolean`

#### Returns

(
  \| `"qwen3-next-80b-a3b"`
  \| `"claude-haiku-4-5-20251001"`
  \| `"claude-opus-4-5-20251101"`
  \| `"claude-opus-4-6"`
  \| `"claude-opus-4-7"`
  \| `"claude-opus-4-8"`
  \| `"claude-sonnet-4-5-20250929"`
  \| `"claude-sonnet-4-6"`
  \| `"claude-sonnet-5"`
  \| `"gemini-2.5-flash"`
  \| `"gemini-2.5-flash-lite"`
  \| `"gemini-2.5-pro"`
  \| `"gemini-3.1-flash-lite"`
  \| `"gemini-3.5-flash"`
  \| `"gemini-3.5-flash-lite"`
  \| `"gemini-3.6-flash"`
  \| `"gpt-4.1"`
  \| `"gpt-5"`
  \| `"gpt-5-mini"`
  \| `"gpt-5-nano"`
  \| `"gpt-5.1"`
  \| `"gpt-5.2"`
  \| `"gpt-5.5"`
  \| `"gpt-5.6-luna"`
  \| `"gpt-5.6-terra"`
  \| `"gpt-oss-120b"`
  \| `"gpt-oss-20b"`
  \| `"kimi-k2.5"`
  \| `"qwen3-32B"`
  \| `"qwen3.5-4b-32k-experimental"`)[]

***

### google()

```ts
function google(opts: GoogleOptions): GoogleProvider;
```

Build a Google (Gemini) LLM descriptor for pipeline mode. The API key is
resolved host-side from the agent's env (`GOOGLE_GENERATIVE_AI_API_KEY`).

#### Parameters

##### opts

[`GoogleOptions`](#googleoptions)

#### Returns

[`GoogleProvider`](#googleprovider)

***

### groq()

```ts
function groq(opts: GroqOptions): GroqProvider;
```

Build a Groq LLM descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`GROQ_API_KEY`).

#### Parameters

##### opts

[`GroqOptions`](#groqoptions)

#### Returns

[`GroqProvider`](#groqprovider)

***

### mistral()

```ts
function mistral(opts: MistralOptions): MistralProvider;
```

Build a Mistral LLM descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`MISTRAL_API_KEY`).

#### Parameters

##### opts

[`MistralOptions`](#mistraloptions)

#### Returns

[`MistralProvider`](#mistralprovider)

***

### openai()

```ts
function openai(opts: OpenAIOptions): OpenAIProvider;
```

Build an OpenAI LLM descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`OPENAI_API_KEY`).

#### Parameters

##### opts

[`OpenAIOptions`](#openaioptions)

#### Returns

[`OpenAIProvider`](#openaiprovider)

***

### openrouter()

```ts
function openrouter(opts: OpenRouterOptions): OpenRouterProvider;
```

Build an OpenRouter descriptor.

The API key is resolved host-side from the agent's env
(`OPENROUTER_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

#### Parameters

##### opts

[`OpenRouterOptions`](#openrouteroptions)

#### Returns

[`OpenRouterProvider`](#openrouterprovider)

***

### xai()

```ts
function xai(opts: XaiOptions): XaiProvider;
```

Build an xAI (Grok) LLM descriptor for pipeline mode. The API key is
resolved host-side from the agent's env (`XAI_API_KEY`).

#### Parameters

##### opts

[`XaiOptions`](#xaioptions)

#### Returns

[`XaiProvider`](#xaiprovider)
