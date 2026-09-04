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
import { openAIS2s } from "@alexkroman1/aai/s2s";

export default agent({
  name: "Concierge",
  systemPrompt: "You are a hotel concierge. Be brief.",
  s2s: openAIS2s({ model: "gpt-realtime", voice: "marin" }),
});
```

`s2s` and the pipeline fields refuse each other at COMPILE time, and so does
the top-level `voice` convenience — an S2S voice rides on the descriptor,
because it is the service that synthesizes.

**[assemblyAIS2s](index.md#assemblyais2s) is also on the root barrel**, which is the one
exception to "provider factories live on subpaths". S2S became opt-in when
the pipeline became the default mode, so the descriptor that opts in sits
beside `agent()` where an author meets it. `openAIS2s` is on this
subpath alone, like every other vendor.

**Credentials are never passed here.** Each factory's vendor names the env
var its key is read from — `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY` — and the
host reads it out of the agent's own environment when the session starts.
That is what keeps a descriptor safe to serialize across the CLI → server →
guest boundary. The variable NAMES are not published: an author never types
one, and the one case for repointing a stage is `apiKeyEnv` on the
AssemblyAI descriptor, which this stage carries too.

## The descriptor type is on the ROOT barrel TOO

`S2sProvider` — what a factory here returns — is also exported from
`@alexkroman1/aai`, beside the other three stage types, so an agent
annotating two stages writes one import rather than two. It stays here as
well: this is where the factory that produces one lives.
`ProviderDescriptor`, the base all four narrow, is on the root ALONE now —
one interface with four reference pages was three too many.

## Functions

### openAIS2s()

```ts
function openAIS2s(options?: OpenAIS2sOptions): S2sProvider;
```

Build an OpenAI Realtime S2S descriptor — the explicit opt-in to
speech-to-speech mode on OpenAI's Realtime API. The API key is resolved
host-side from the agent's env (`OPENAI_API_KEY`).

#### Parameters

##### options?

[`OpenAIS2sOptions`](#openais2soptions)

#### Returns

[`S2sProvider`](index.md#s2sprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { openAIS2s } from "@alexkroman1/aai/s2s";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  s2s: openAIS2s({ model: "gpt-realtime", voice: "marin" }),
});
```

Setting `s2s` replaces the whole `stt`/`llm`/`tts` pipeline.

## Interfaces

### OpenAIS2sOptions

Options for [openAIS2s](#openais2s).

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
optional voice?: OpenAIS2sVoice;
```

TTS voice. Default applied by the host (currently `"alloy"`).

## Type Aliases

### OpenAIS2sVoice

```ts
type OpenAIS2sVoice = 
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

## References

### assemblyAIS2s

Re-exports [assemblyAIS2s](index.md#assemblyais2s)

***

### AssemblyAIS2sOptions

Re-exports [AssemblyAIS2sOptions](index.md#assemblyais2soptions)

***

### ProviderCredentialOptions

Re-exports [ProviderCredentialOptions](index.md#providercredentialoptions)

***

### S2sProvider

Re-exports [S2sProvider](index.md#s2sprovider)
