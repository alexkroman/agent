# tts

`@alexkroman1/aai/tts` subpath barrel — the text-to-speech stage of a
pipeline agent.

Three vendors, one shape: each factory returns a serializable DESCRIPTOR
(`{ kind, options }`), and you hand it to `agent({ tts })`. Nothing here
opens a socket or reads a credential — the host resolves the descriptor at
session start, so importing this barrel pulls in no vendor SDK.

## Example

**Swap the TTS stage of an otherwise default agent**

```ts
import { agent } from "@alexkroman1/aai";
import { CARTESIA_DEFAULT_VOICE, cartesia } from "@alexkroman1/aai/tts";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  // `stt` and `llm` keep their AssemblyAI defaults.
  tts: cartesia({ voice: CARTESIA_DEFAULT_VOICE, model: "sonic-3" }),
});
```

**Picking a voice is the one setting a TTS stage cannot infer**, and an
unrecognised id has no authoring-time symptom: the agent connects, reports
ready and is permanently silent. For AssemblyAI the ids are enumerated in
[ASSEMBLYAI\_TTS\_VOICES](index.md#assemblyai_tts_voices), with each accent alongside — read them there
rather than trusting a name from anywhere else, and note the TYPE cannot
enforce it ([AssemblyAITtsVoice](index.md#assemblyaittsvoice) says why). On the default pipeline
you do not need this barrel at all: `agent({ voice: "michael" })` desugars
to [assemblyAITts](#assemblyaitts).

**Credentials are never passed here.** Each factory's vendor names the env
var its key is read from — `ASSEMBLYAI_API_KEY`, `CARTESIA_API_KEY`,
`RIME_API_KEY` — and the host reads it out of the agent's own environment
when the session starts. That is what keeps a descriptor safe to serialize
across the CLI → server → guest boundary. The variable NAMES are not
published: an author never types one, and the one case for repointing a
stage is `apiKeyEnv` on the AssemblyAI descriptor.

## The descriptor type is on the ROOT barrel TOO

`TtsProvider` — what a factory here returns — is also exported from
`@alexkroman1/aai`, beside the other three stage types, so an agent
annotating two stages writes one import rather than two. It stays here as
well: this is where the factory that produces one lives.
`ProviderDescriptor`, the base all four narrow, is on the root ALONE now —
one interface with four reference pages was three too many.

## The host-side opener contract is on `/runtime`

Implementing a TTS vendor of your own — `TtsOpenOptions`, `TtsSession`,
`TtsEvents`, `TtsError`, `TtsWordTiming`, `Unsubscribe` — is a HOST job, and
those types live on `@alexkroman1/aai-runtime` beside `registerTtsKind`,
which is what you hand the opener to.

## Functions

### assemblyAITts()

```ts
function assemblyAITts(opts?: AssemblyAITtsOptions): TtsProvider;
```

Build an AssemblyAI streaming-TTS descriptor.

The API key is resolved host-side from the agent's env
(`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

Named `assemblyAITts` (not `assemblyAI`) so the STT
(`assemblyAIStt`), LLM (`assemblyAILlm`), and TTS factories can be
imported side by side without aliasing.

#### Parameters

##### opts?

[`AssemblyAITtsOptions`](#assemblyaittsoptions)

#### Returns

[`TtsProvider`](index.md#ttsprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAITts } from "@alexkroman1/aai/tts";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  tts: assemblyAITts({ voice: "michael" }),
});
```

On the default pipeline `agent({ voice: "michael" })` is the shorthand
for exactly this. Voice ids come from [ASSEMBLYAI\_TTS\_VOICES](index.md#assemblyai_tts_voices) and
nowhere else — an unrecognised one leaves an agent that connects,
reports ready and never speaks.

***

### cartesia()

```ts
function cartesia(opts?: CartesiaOptions): TtsProvider;
```

Build a Cartesia TTS descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`CARTESIA_API_KEY`).

#### Parameters

##### opts?

[`CartesiaOptions`](#cartesiaoptions)

#### Returns

[`TtsProvider`](index.md#ttsprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { CARTESIA_DEFAULT_VOICE, cartesia } from "@alexkroman1/aai/tts";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  tts: cartesia({ voice: CARTESIA_DEFAULT_VOICE, model: "sonic-3" }),
});
```

***

### rime()

```ts
function rime(opts?: RimeOptions): TtsProvider;
```

Build a Rime TTS descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`RIME_API_KEY`).

#### Parameters

##### opts?

[`RimeOptions`](#rimeoptions)

#### Returns

[`TtsProvider`](index.md#ttsprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { RIME_DEFAULT_VOICE, rime } from "@alexkroman1/aai/tts";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  tts: rime({ voice: RIME_DEFAULT_VOICE, model: "mistv2" }),
});
```

## Interfaces

### AssemblyAITtsOptions

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

##### host?

```ts
optional host?: string;
```

Streaming-TTS host to dial, replacing the production `ASSEMBLYAI_TTS_HOST`. A bare
host (`streaming-tts.sandbox000.assemblyai-labs.com`), not a URL — the
adapter owns the `wss://` scheme and the `/v1/ws/` path, so a full URL here
would be wrong in a way that only shows up at connect.

Intended for pre-release/staging clusters, and it is the TTS half of the
same A/B `assemblyAIStt({ streamingUrl })` gives STT. A staging cluster
generally issues its own keys, so point every AssemblyAI stage at the same
environment or the ones left on production reject the key. Leave unset in
production.

##### language?

```ts
optional language?: "en" | "it" | "es" | "de" | "pt" | "fr";
```

Spoken language as an ISO 639-1 code (`"en"`, `"fr"`, `"de"`, `"es"`,
`"it"`, `"pt"`). Omitted by default so the server infers it from the
voice — set it only alongside a voice that speaks it. Translated
internally to the service's language name; see
[ASSEMBLYAI\_TTS\_LANGUAGES](#assemblyai_tts_languages) for the supported set. An unsupported
code fails at connect time rather than muting the session.

##### voice?

```ts
optional voice?: AssemblyAITtsVoice;
```

Voice id, e.g. `"jane"`, `"michael"`, `"vera"`. Defaults to
[ASSEMBLYAI\_TTS\_DEFAULT\_VOICE](#assemblyai_tts_default_voice). Each voice speaks exactly one
language — see [ASSEMBLYAI\_TTS\_VOICES](index.md#assemblyai_tts_voices) for the catalog.

***

### CartesiaOptions

Options for [cartesia](#cartesia).

#### Properties

##### language?

```ts
optional language?: string;
```

Spoken language hint. Defaults to `"en"`.

##### model?

```ts
optional model?: string;
```

Model ID. Defaults to `"sonic-2"`.

##### voice?

```ts
optional voice?: string;
```

Cartesia voice ID. Defaults to [CARTESIA\_DEFAULT\_VOICE](#cartesia_default_voice).

***

### RimeOptions

Options for [rime](#rime).

#### Properties

##### language?

```ts
optional language?: string;
```

Spoken language. Uses ISO 639-3 (three-letter codes).
Defaults to `"eng"` (English).

Note: Rime uses 3-letter codes — use `"eng"` not `"en"`.

##### model?

```ts
optional model?: string;
```

Rime model ID. Defaults to `"mistv2"` (Rime's most compatible model).
Common values: `"mistv2"`, `"arcana"`.

##### voice?

```ts
optional voice?: string;
```

Rime speaker ID. Defaults to [RIME\_DEFAULT\_VOICE](#rime_default_voice).

## Type Aliases

### AssemblyAITtsLanguage

```ts
type AssemblyAITtsLanguage = keyof typeof ASSEMBLYAI_TTS_LANGUAGES;
```

ISO 639-1 code for a language the AssemblyAI voice catalog speaks.

## Variables

### ASSEMBLYAI\_TTS\_DEFAULT\_VOICE

```ts
const ASSEMBLYAI_TTS_DEFAULT_VOICE: "jane" = "jane";
```

Default voice when `assemblyAITts()` is called with no `voice` — a
US-accented English voice, since most agents face US callers (it was
`"vera"` for a while, which put a UK accent on every agent that never
chose). Pick from [ASSEMBLYAI\_TTS\_VOICES](index.md#assemblyai_tts_voices) to change it; every voice
in the catalog speaks exactly one language, so changing `language`
generally means changing `voice` too.

***

### ASSEMBLYAI\_TTS\_LANGUAGES

```ts
const ASSEMBLYAI_TTS_LANGUAGES: {
  de: "german";
  en: "english";
  es: "spanish";
  fr: "french";
  it: "italian";
  pt: "portuguese";
};
```

ISO 639-1 code → the `language` query-param value the service accepts.

The streaming-TTS endpoint takes the **full lowercase English name**, not a
code: `?language=es` is refused with `Bad connection parameters: language:
language 'es' not in supported set ['english', 'french', 'german',
'italian', 'portuguese', 'spanish']`. That refusal arrives *in-band* after
the socket opens, so an unmapped code doesn't fail the session — it leaves
the agent connected, "ready", and permanently mute. Every other language
knob in the ecosystem (AssemblyAI STT's `language_codes`, Cartesia) is a
code, so the codes are the SDK's contract and this map is the translation.

Keys are the six languages the voice catalog covers.

#### Type Declaration

##### de

```ts
readonly de: "german";
```

##### en

```ts
readonly en: "english";
```

##### es

```ts
readonly es: "spanish";
```

##### fr

```ts
readonly fr: "french";
```

##### it

```ts
readonly it: "italian";
```

##### pt

```ts
readonly pt: "portuguese";
```

***

### CARTESIA\_DEFAULT\_VOICE

```ts
const CARTESIA_DEFAULT_VOICE: "f786b574-daa5-4673-aa0c-cbe3e8534c02" = "f786b574-daa5-4673-aa0c-cbe3e8534c02";
```

Default voice used when callers invoke `cartesia()` with no `voice`. This
is the same voice the example templates ship with, so a bare `cartesia()`
works out of the box for new agents.

***

### RIME\_DEFAULT\_VOICE

```ts
const RIME_DEFAULT_VOICE: "cove" = "cove";
```

Default Rime speaker used when callers invoke `rime()` with no `voice`.
`cove` is a `mistv2` speaker, matching the default model below — so a
bare `rime()` works out of the box for new agents.

## References

### ASSEMBLYAI\_TTS\_VOICES

Re-exports [ASSEMBLYAI_TTS_VOICES](index.md#assemblyai_tts_voices)

***

### AssemblyAITtsVoice

Re-exports [AssemblyAITtsVoice](index.md#assemblyaittsvoice)

***

### TtsProvider

Re-exports [TtsProvider](index.md#ttsprovider)
