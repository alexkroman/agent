# llm

`@alexkroman1/aai/llm` subpath barrel — the model that drives the reply.

Nine vendors, one shape: each factory returns a serializable DESCRIPTOR
(`{ kind, options }`), and you hand it to `agent({ llm })`. Import from here
rather than from `@ai-sdk/anthropic` directly — the vendor SDK is loaded
host-side when the session starts, so the agent bundle stays free of its
eager env reads and other load-time side effects.

## Example

**Swap the LLM of an otherwise default agent**

```ts
import { agent } from "@alexkroman1/aai";
import { anthropicLlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  // `stt` and `tts` keep their AssemblyAI defaults.
  llm: anthropicLlm({ model: "claude-sonnet-5" }),
});
```

`agent({ llm })` also takes a bare gateway model id — `llm: "zai/glm-4.6"` —
which is the shorthand for [gatewayLlm](#gatewayllm). Every other stage needs a
factory.

**Credentials are never passed here.** Each factory's vendor names the env
var its key is read from — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`ASSEMBLYAI_API_KEY`, … — and the host reads it out of the agent's own
environment when the session starts. That is what keeps a descriptor safe to
serialize across the CLI → server → guest boundary. The variable NAMES are
not published: an author never types one, and the one case for repointing a
stage is `apiKeyEnv` on the AssemblyAI descriptor.

Eight of the nine take [ModelOptions](#modeloptions) — one model id and nothing else,
REQUIRED, because a third-party vendor's catalog is not this SDK's to
default from. Only [assemblyAILlm](#assemblyaillm) has a default
([ASSEMBLYAI\_LLM\_DEFAULT\_MODEL](#assemblyai_llm_default_model)) and so a bare call.

Two vendors here are AGGREGATORS rather than model owners, addressed as
`"creator/model"`: [openRouterLlm](#openrouterllm) and [gatewayLlm](#gatewayllm). A third,
[assemblyAILlm](#assemblyaillm), fronts AssemblyAI's own gateway — its ids are
[AssemblyAIGatewayModel](#assemblyaigatewaymodel), and the CATALOG behind that union (which
model streams, calls tools, serves the EU) is on
`@alexkroman1/aai/host-internal`, since its readers are the studio's model
selection and this repo's own gate rather than an `agent.ts`.

## The descriptor type is on the ROOT barrel TOO

`LlmProvider` — what a factory here returns — is also exported from
`@alexkroman1/aai`, beside the other three stage types, so an agent
annotating two stages writes one import rather than two. It stays here as
well: this is where the factory that produces one lives.
`ProviderDescriptor`, the base all four narrow, is on the root ALONE now —
one interface with four reference pages was three too many.

## Functions

### anthropicLlm()

```ts
function anthropicLlm(opts: AnthropicLlmOptions): LlmProvider;
```

Build an Anthropic (Claude) LLM descriptor for pipeline mode. The API key
is resolved host-side from the agent's env (`ANTHROPIC_API_KEY`).

#### Parameters

##### opts

[`AnthropicLlmOptions`](#anthropicllmoptions)

#### Returns

[`LlmProvider`](index.md#llmprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { anthropicLlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  llm: anthropicLlm({ model: "claude-sonnet-5" }),
});
```

***

### assemblyAILlm()

```ts
function assemblyAILlm(opts?: AssemblyAILlmOptions): LlmProvider;
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

[`LlmProvider`](index.md#llmprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAILlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  llm: assemblyAILlm({ model: "qwen3-next-80b-a3b", reasoningEffort: "none" }),
});
```

Every option is optional: `assemblyAILlm()` runs
[ASSEMBLYAI\_LLM\_DEFAULT\_MODEL](#assemblyai_llm_default_model). `region: "eu"` selects the EU
gateway; [AssemblyAIGatewayModel](#assemblyaigatewaymodel) is the id set.

***

### gatewayLlm()

```ts
function gatewayLlm(opts: GatewayLlmOptions): LlmProvider;
```

Build a Vercel AI Gateway descriptor.

The API key is resolved host-side from the agent's env
(`AI_GATEWAY_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

#### Parameters

##### opts

[`GatewayLlmOptions`](#gatewayllmoptions)

#### Returns

[`LlmProvider`](index.md#llmprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { gatewayLlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  llm: gatewayLlm({ model: "zai/glm-4.6" }),
});
```

One key, hundreds of models, addressed `"creator/model"`. See
https://vercel.com/ai-gateway/models for the list.

***

### googleLlm()

```ts
function googleLlm(opts: GoogleLlmOptions): LlmProvider;
```

Build a Google (Gemini) LLM descriptor for pipeline mode. The API key is
resolved host-side from the agent's env (`GOOGLE_GENERATIVE_AI_API_KEY`).

#### Parameters

##### opts

[`GoogleLlmOptions`](#googlellmoptions)

#### Returns

[`LlmProvider`](index.md#llmprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { googleLlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  llm: googleLlm({ model: "gemini-2.5-flash" }),
});
```

***

### groqLlm()

```ts
function groqLlm(opts: GroqLlmOptions): LlmProvider;
```

Build a Groq LLM descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`GROQ_API_KEY`).

#### Parameters

##### opts

[`GroqLlmOptions`](#groqllmoptions)

#### Returns

[`LlmProvider`](index.md#llmprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { groqLlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  llm: groqLlm({ model: "llama-3.3-70b-versatile" }),
});
```

***

### mistralLlm()

```ts
function mistralLlm(opts: MistralLlmOptions): LlmProvider;
```

Build a Mistral LLM descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`MISTRAL_API_KEY`).

#### Parameters

##### opts

[`MistralLlmOptions`](#mistralllmoptions)

#### Returns

[`LlmProvider`](index.md#llmprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { mistralLlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  llm: mistralLlm({ model: "mistral-large-latest" }),
});
```

***

### openAILlm()

```ts
function openAILlm(opts: OpenAILlmOptions): LlmProvider;
```

Build an OpenAI LLM descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`OPENAI_API_KEY`).

#### Parameters

##### opts

[`OpenAILlmOptions`](#openaillmoptions)

#### Returns

[`LlmProvider`](index.md#llmprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { openAILlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  llm: openAILlm({ model: "gpt-5.5" }),
});
```

***

### openRouterLlm()

```ts
function openRouterLlm(opts: OpenRouterLlmOptions): LlmProvider;
```

Build an OpenRouter descriptor.

The API key is resolved host-side from the agent's env
(`OPENROUTER_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

#### Parameters

##### opts

[`OpenRouterLlmOptions`](#openrouterllmoptions)

#### Returns

[`LlmProvider`](index.md#llmprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { openRouterLlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  llm: openRouterLlm({ model: "meta-llama/llama-3.3-70b-instruct" }),
});
```

One key, hundreds of models, addressed `"creator/model"`. See
https://openrouter.ai/models for the list.

***

### xAILlm()

```ts
function xAILlm(opts: XAILlmOptions): LlmProvider;
```

Build an xAI (Grok) LLM descriptor for pipeline mode. The API key is
resolved host-side from the agent's env (`XAI_API_KEY`).

#### Parameters

##### opts

[`XAILlmOptions`](#xaillmoptions)

#### Returns

[`LlmProvider`](index.md#llmprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { xAILlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  llm: xAILlm({ model: "grok-4" }),
});
```

## Interfaces

### AnthropicLlmOptions

Options for [anthropicLlm](#anthropicllm).

Empty over [ModelOptions](#modeloptions) on purpose: this vendor is reached by naming
one model id, and every vendor still gets a NAME for its own options so its
first vendor-specific setting is an additive field here rather than a re-split
of the shared interface across eight call sites.

#### Extends

- [`ModelOptions`](#modeloptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ModelOptions`](#modeloptions).[`apiKeyEnv`](#apikeyenv-6)

##### model

```ts
model: string;
```

The vendor's own model id, e.g. `"claude-sonnet-5"`, `"gpt-5.5"`,
`"gemini-2.5-flash"`. The two aggregator factories (`openRouterLlm`,
`gatewayLlm`) address a model as `"creator/model"`; each module's doc names
the shape it takes.

Required: a third-party vendor's catalog is not this SDK's to default
from, and an id invented on its behalf fails at the first session.

###### Inherited from

[`ModelOptions`](#modeloptions).[`model`](#model-6)

***

### AssemblyAILlmOptions

Options for [assemblyAILlm](#assemblyaillm).

#### Extends

- [`ProviderCredentialOptions`](index.md#providercredentialoptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ProviderCredentialOptions`](index.md#providercredentialoptions).[`apiKeyEnv`](index.md#apikeyenv-1)

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
  | AssemblyAIGatewayModel;
```

Gateway model id — [AssemblyAIGatewayModel](#assemblyaigatewaymodel) is the generated union
of what `/v1/models` advertises. (The catalog BEHIND it, recording which
models stream, call tools and serve the EU region, is
`ASSEMBLYAI_GATEWAY_MODELS` on `@alexkroman1/aai/host-internal`; an
`agent.ts` picks an id, not a capability row.)

Typed against that union so a name the gateway does not carry is caught
where it is written, rather than as a 400 at the first session. A plain
string is still accepted, because the union is a snapshot of a service
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
residency — six models at time of writing, per the `eu` flag in the
generated catalog. Defaults to `"us"`.

***

### GatewayLlmOptions

Options for [gatewayLlm](#gatewayllm).

Empty over [ModelOptions](#modeloptions) on purpose: this vendor is reached by naming
one model id, and every vendor still gets a NAME for its own options so its
first vendor-specific setting is an additive field here rather than a re-split
of the shared interface across eight call sites.

#### Extends

- [`ModelOptions`](#modeloptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ModelOptions`](#modeloptions).[`apiKeyEnv`](#apikeyenv-6)

##### model

```ts
model: string;
```

The vendor's own model id, e.g. `"claude-sonnet-5"`, `"gpt-5.5"`,
`"gemini-2.5-flash"`. The two aggregator factories (`openRouterLlm`,
`gatewayLlm`) address a model as `"creator/model"`; each module's doc names
the shape it takes.

Required: a third-party vendor's catalog is not this SDK's to default
from, and an id invented on its behalf fails at the first session.

###### Inherited from

[`ModelOptions`](#modeloptions).[`model`](#model-6)

***

### GoogleLlmOptions

Options for [googleLlm](#googlellm).

Empty over [ModelOptions](#modeloptions) on purpose: this vendor is reached by naming
one model id, and every vendor still gets a NAME for its own options so its
first vendor-specific setting is an additive field here rather than a re-split
of the shared interface across eight call sites.

#### Extends

- [`ModelOptions`](#modeloptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ModelOptions`](#modeloptions).[`apiKeyEnv`](#apikeyenv-6)

##### model

```ts
model: string;
```

The vendor's own model id, e.g. `"claude-sonnet-5"`, `"gpt-5.5"`,
`"gemini-2.5-flash"`. The two aggregator factories (`openRouterLlm`,
`gatewayLlm`) address a model as `"creator/model"`; each module's doc names
the shape it takes.

Required: a third-party vendor's catalog is not this SDK's to default
from, and an id invented on its behalf fails at the first session.

###### Inherited from

[`ModelOptions`](#modeloptions).[`model`](#model-6)

***

### GroqLlmOptions

Options for [groqLlm](#groqllm).

Empty over [ModelOptions](#modeloptions) on purpose: this vendor is reached by naming
one model id, and every vendor still gets a NAME for its own options so its
first vendor-specific setting is an additive field here rather than a re-split
of the shared interface across eight call sites.

#### Extends

- [`ModelOptions`](#modeloptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ModelOptions`](#modeloptions).[`apiKeyEnv`](#apikeyenv-6)

##### model

```ts
model: string;
```

The vendor's own model id, e.g. `"claude-sonnet-5"`, `"gpt-5.5"`,
`"gemini-2.5-flash"`. The two aggregator factories (`openRouterLlm`,
`gatewayLlm`) address a model as `"creator/model"`; each module's doc names
the shape it takes.

Required: a third-party vendor's catalog is not this SDK's to default
from, and an id invented on its behalf fails at the first session.

###### Inherited from

[`ModelOptions`](#modeloptions).[`model`](#model-6)

***

### MistralLlmOptions

Options for [mistralLlm](#mistralllm).

Empty over [ModelOptions](#modeloptions) on purpose: this vendor is reached by naming
one model id, and every vendor still gets a NAME for its own options so its
first vendor-specific setting is an additive field here rather than a re-split
of the shared interface across eight call sites.

#### Extends

- [`ModelOptions`](#modeloptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ModelOptions`](#modeloptions).[`apiKeyEnv`](#apikeyenv-6)

##### model

```ts
model: string;
```

The vendor's own model id, e.g. `"claude-sonnet-5"`, `"gpt-5.5"`,
`"gemini-2.5-flash"`. The two aggregator factories (`openRouterLlm`,
`gatewayLlm`) address a model as `"creator/model"`; each module's doc names
the shape it takes.

Required: a third-party vendor's catalog is not this SDK's to default
from, and an id invented on its behalf fails at the first session.

###### Inherited from

[`ModelOptions`](#modeloptions).[`model`](#model-6)

***

### ModelOptions

Options for an LLM factory whose only setting is which model to run.

#### Extends

- [`ProviderCredentialOptions`](index.md#providercredentialoptions)

#### Extended by

- [`AnthropicLlmOptions`](#anthropicllmoptions)
- [`GatewayLlmOptions`](#gatewayllmoptions)
- [`GoogleLlmOptions`](#googlellmoptions)
- [`GroqLlmOptions`](#groqllmoptions)
- [`MistralLlmOptions`](#mistralllmoptions)
- [`OpenAILlmOptions`](#openaillmoptions)
- [`OpenRouterLlmOptions`](#openrouterllmoptions)
- [`XAILlmOptions`](#xaillmoptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ProviderCredentialOptions`](index.md#providercredentialoptions).[`apiKeyEnv`](index.md#apikeyenv-1)

##### model

```ts
model: string;
```

The vendor's own model id, e.g. `"claude-sonnet-5"`, `"gpt-5.5"`,
`"gemini-2.5-flash"`. The two aggregator factories (`openRouterLlm`,
`gatewayLlm`) address a model as `"creator/model"`; each module's doc names
the shape it takes.

Required: a third-party vendor's catalog is not this SDK's to default
from, and an id invented on its behalf fails at the first session.

***

### OpenAILlmOptions

Options for [openAILlm](#openaillm).

Empty over [ModelOptions](#modeloptions) on purpose: this vendor is reached by naming
one model id, and every vendor still gets a NAME for its own options so its
first vendor-specific setting is an additive field here rather than a re-split
of the shared interface across eight call sites.

#### Extends

- [`ModelOptions`](#modeloptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ModelOptions`](#modeloptions).[`apiKeyEnv`](#apikeyenv-6)

##### model

```ts
model: string;
```

The vendor's own model id, e.g. `"claude-sonnet-5"`, `"gpt-5.5"`,
`"gemini-2.5-flash"`. The two aggregator factories (`openRouterLlm`,
`gatewayLlm`) address a model as `"creator/model"`; each module's doc names
the shape it takes.

Required: a third-party vendor's catalog is not this SDK's to default
from, and an id invented on its behalf fails at the first session.

###### Inherited from

[`ModelOptions`](#modeloptions).[`model`](#model-6)

***

### OpenRouterLlmOptions

Options for [openRouterLlm](#openrouterllm).

Empty over [ModelOptions](#modeloptions) on purpose: this vendor is reached by naming
one model id, and every vendor still gets a NAME for its own options so its
first vendor-specific setting is an additive field here rather than a re-split
of the shared interface across eight call sites.

#### Extends

- [`ModelOptions`](#modeloptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ModelOptions`](#modeloptions).[`apiKeyEnv`](#apikeyenv-6)

##### model

```ts
model: string;
```

The vendor's own model id, e.g. `"claude-sonnet-5"`, `"gpt-5.5"`,
`"gemini-2.5-flash"`. The two aggregator factories (`openRouterLlm`,
`gatewayLlm`) address a model as `"creator/model"`; each module's doc names
the shape it takes.

Required: a third-party vendor's catalog is not this SDK's to default
from, and an id invented on its behalf fails at the first session.

###### Inherited from

[`ModelOptions`](#modeloptions).[`model`](#model-6)

***

### XAILlmOptions

Options for [xAILlm](#xaillm).

Empty over [ModelOptions](#modeloptions) on purpose: this vendor is reached by naming
one model id, and every vendor still gets a NAME for its own options so its
first vendor-specific setting is an additive field here rather than a re-split
of the shared interface across eight call sites.

#### Extends

- [`ModelOptions`](#modeloptions)

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding this stage's credential, replacing the provider default.
Names a VARIABLE, not a key.

###### Inherited from

[`ModelOptions`](#modeloptions).[`apiKeyEnv`](#apikeyenv-6)

##### model

```ts
model: string;
```

The vendor's own model id, e.g. `"claude-sonnet-5"`, `"gpt-5.5"`,
`"gemini-2.5-flash"`. The two aggregator factories (`openRouterLlm`,
`gatewayLlm`) address a model as `"creator/model"`; each module's doc names
the shape it takes.

Required: a third-party vendor's catalog is not this SDK's to default
from, and an id invented on its behalf fails at the first session.

###### Inherited from

[`ModelOptions`](#modeloptions).[`model`](#model-6)

## Type Aliases

### AssemblyAIGatewayModel

```ts
type AssemblyAIGatewayModel = 
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
  | "qwen3-next-80b-a3b"
  | "qwen3.5-4b-32k-experimental";
```

An id the gateway advertises.

***

### AssemblyAIReasoningEffort

```ts
type AssemblyAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";
```

Reasoning effort accepted by the gateway's GPT-5-family models, including
the two off switches: `"none"` (gpt-5.1 and later) and `"minimal"` (the
original `gpt-5`/`-mini`/`-nano`, whose lowest setting that is).

## Variables

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

### OPENROUTER\_BASE\_URL

```ts
const OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1" = "https://openrouter.ai/api/v1";
```

OpenRouter's OpenAI-compatible API endpoint.

## References

### LlmProvider

Re-exports [LlmProvider](index.md#llmprovider)

***

### ProviderCredentialOptions

Re-exports [ProviderCredentialOptions](index.md#providercredentialoptions)
