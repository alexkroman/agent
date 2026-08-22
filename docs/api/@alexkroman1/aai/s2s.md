# s2s

`@alexkroman1/aai/s2s` subpath barrel — speech-to-speech, where the whole
turn runs service-side.

S2S is the OTHER session mode, and it is opt-in: setting `s2s` replaces the
`stt`/`llm`/`tts` pipeline entirely, so transcription, the model loop and
synthesis all happen inside one vendor socket. Two vendors, one shape — each
factory returns a serializable DESCRIPTOR (`{ kind, options }`), and nothing
here opens a socket or reads a credential.

## Example

**An OpenAI Realtime agent**

```ts
import { agent } from "@alexkroman1/aai";
import { openaiRealtime } from "@alexkroman1/aai/s2s";

export default agent({
  name: "Concierge",
  systemPrompt: "You are a hotel concierge. Be brief.",
  s2s: openaiRealtime({ model: "gpt-realtime", voice: "marin" }),
});
```

`s2s` and the pipeline fields refuse each other at COMPILE time, and so does
the top-level `voice` convenience — an S2S voice rides on the descriptor,
because it is the service that synthesizes.

**[assemblyAIS2s](index.md#assemblyais2s) is also on the root barrel**, which is the one
exception to "provider factories live on subpaths". S2S became opt-in when
the pipeline became the default mode, so the descriptor that opts in sits
beside `agent()` where an author meets it; the two `*_KIND`/`*_API_KEY_ENV`
constants an author never writes stay here only. `openaiRealtime` is on this
subpath alone, like every other vendor.

**Credentials are never passed here.** Each factory's vendor names the env
var its key is read from — `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY`, each also
exported as a `*_API_KEY_ENV` constant — and the host reads it out of the
agent's own environment when the session starts. That is what keeps a
descriptor safe to serialize across the CLI → server → guest boundary.

## Functions

### openaiRealtime()

```ts
function openaiRealtime(opts?: OpenaiRealtimeOptions): OpenaiRealtimeProvider;
```

Build an OpenAI Realtime S2S descriptor — the explicit opt-in to
speech-to-speech mode on OpenAI's Realtime API. The API key is resolved
host-side from the agent's env (`OPENAI_API_KEY`).

#### Parameters

##### opts?

[`OpenaiRealtimeOptions`](#openairealtimeoptions)

#### Returns

[`OpenaiRealtimeProvider`](#openairealtimeprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { openaiRealtime } from "@alexkroman1/aai/s2s";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  s2s: openaiRealtime({ model: "gpt-realtime", voice: "marin" }),
});
```

Setting `s2s` replaces the whole `stt`/`llm`/`tts` pipeline.

## Type Aliases

### OpenaiRealtimeOptions

```ts
type OpenaiRealtimeOptions = {
  model?: string;
  url?: string;
  voice?: OpenaiRealtimeVoice;
};
```

Options for [openaiRealtime](#openairealtime).

#### Properties

##### model?

```ts
optional model?: string;
```

Realtime model identifier. Default applied by the host (currently `"gpt-realtime-2"`).

##### url?

```ts
optional url?: string;
```

Override the WebSocket base URL (testing/proxy).

##### voice?

```ts
optional voice?: OpenaiRealtimeVoice;
```

TTS voice. Default applied by the host (currently `"alloy"`).

***

### OpenaiRealtimeProvider

```ts
type OpenaiRealtimeProvider = S2sProvider & {
  kind: typeof OPENAI_REALTIME_KIND;
  options: OpenaiRealtimeOptions;
};
```

Descriptor returned by [openaiRealtime](#openairealtime).

#### Type Declaration

##### kind

```ts
readonly kind: typeof OPENAI_REALTIME_KIND;
```

##### options

```ts
readonly options: OpenaiRealtimeOptions;
```

***

### OpenaiRealtimeVoice

```ts
type OpenaiRealtimeVoice = 
  | "alloy"
  | "ash"
  | "ballad"
  | "cedar"
  | "coral"
  | "echo"
  | "marin"
  | "sage"
  | "shimmer"
  | "verse";
```

Voice ids the OpenAI Realtime API accepts for TTS.

***

### S2sProvider

```ts
type S2sProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  __stage?: "s2s";
};
```

Descriptor for an S2S provider. Returned by `assemblyAIS2s(...)` (root
export) or `openaiRealtime(...)` from `@alexkroman1/aai/s2s`.

#### Type Declaration

##### \_\_stage?

```ts
readonly optional __stage?: "s2s";
```

Compile-time stage tag; never present at runtime.

## Variables

### ASSEMBLYAI\_S2S\_API\_KEY\_ENV

```ts
const ASSEMBLYAI_S2S_API_KEY_ENV: "ASSEMBLYAI_API_KEY" = "ASSEMBLYAI_API_KEY";
```

Env var holding this stage's credential.

The same string as the STT/TTS/LLM AssemblyAI constants by design — a
distinct NAME per stage is what lets `apiKeyEnv` point one stage at another
account without moving the others (see `descriptorEnvVar` in
the host-side resolver).

***

### ASSEMBLYAI\_S2S\_KIND

```ts
const ASSEMBLYAI_S2S_KIND: "assemblyai";
```

Kind tag recognised by the host-side resolver.

***

### OPENAI\_REALTIME\_API\_KEY\_ENV

```ts
const OPENAI_REALTIME_API_KEY_ENV: "OPENAI_API_KEY" = "OPENAI_API_KEY";
```

Env var holding this stage's credential — the same string as the OpenAI LLM
constant, under a name of its own so `apiKeyEnv` can repoint this stage
alone (the host-side resolver reads it).

***

### OPENAI\_REALTIME\_KIND

```ts
const OPENAI_REALTIME_KIND: "openai-realtime";
```

Kind tag recognised by the host-side resolver.

## References

### assemblyAIS2s

Re-exports [assemblyAIS2s](index.md#assemblyais2s)

***

### AssemblyAIS2sOptions

Re-exports [AssemblyAIS2sOptions](index.md#assemblyais2soptions)

***

### AssemblyAIS2sProvider

Re-exports [AssemblyAIS2sProvider](index.md#assemblyais2sprovider)

***

### ProviderDescriptor

Re-exports [ProviderDescriptor](stt.md#providerdescriptor)
