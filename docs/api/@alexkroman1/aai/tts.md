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
import { CARTESIA_DEFAULT_VOICE, cartesiaTts } from "@alexkroman1/aai/tts";

export default agent({
  name: "Support",
  // `stt` and `llm` keep their AssemblyAI defaults.
  tts: cartesiaTts({ voice: CARTESIA_DEFAULT_VOICE, model: "sonic-3" }),
});
```

**Picking a voice is the one setting a TTS stage cannot infer**, and an
unrecognised id has no authoring-time symptom: the agent connects, reports
ready and is permanently silent. For AssemblyAI the library voices are
[ASSEMBLYAI\_TTS\_VOICES](#assemblyai_tts_voices) — read them there rather than trusting a name
from anywhere else, and note the TYPE cannot enforce it
([AssemblyAITtsVoice](#assemblyaittsvoice) says why). A voice is always a descriptor
option — `tts: assemblyAITts({ voice: "aai-michael" })` — so this
barrel is where one is chosen.

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
function assemblyAITts(options?: AssemblyAITtsOptions): TtsProvider;
```

Build an AssemblyAI streaming-TTS descriptor.

The API key is resolved host-side from the agent's env
(`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

Named `assemblyAITts` (not `assemblyAI`) so the STT
(`assemblyAIStt`), LLM (`llm({ provider: "assemblyai" })`), and TTS factories can be
imported side by side without aliasing.

#### Parameters

##### options?

[`AssemblyAITtsOptions`](#assemblyaittsoptions)

#### Returns

[`TtsProvider`](index.md#ttsprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAITts } from "@alexkroman1/aai/tts";

export default agent({
  name: "Support",
  tts: assemblyAITts({ voice: "aai-michael" }),
});
```

The default pipeline's stage is `assemblyAITts()` — the default voice —
so this is how its voice is changed. Pick from [ASSEMBLYAI\_TTS\_VOICES](#assemblyai_tts_voices)
unless you mean a voice of your own — the service refuses an unknown one when
the session opens.

***

### cartesiaTts()

```ts
function cartesiaTts(options?: CartesiaTtsOptions): TtsProvider;
```

Build a Cartesia TTS descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`CARTESIA_API_KEY`).

#### Parameters

##### options?

[`CartesiaTtsOptions`](#cartesiattsoptions)

#### Returns

[`TtsProvider`](index.md#ttsprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { CARTESIA_DEFAULT_VOICE, cartesiaTts } from "@alexkroman1/aai/tts";

export default agent({
  name: "Support",
  tts: cartesiaTts({ voice: CARTESIA_DEFAULT_VOICE, model: "sonic-3" }),
});
```

***

### rimeTts()

```ts
function rimeTts(options?: RimeTtsOptions): TtsProvider;
```

Build a Rime TTS descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`RIME_API_KEY`).

#### Parameters

##### options?

[`RimeTtsOptions`](#rimettsoptions)

#### Returns

[`TtsProvider`](index.md#ttsprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { RIME_DEFAULT_VOICE, rimeTts } from "@alexkroman1/aai/tts";

export default agent({
  name: "Support",
  tts: rimeTts({ voice: RIME_DEFAULT_VOICE, model: "mistv2" }),
});
```

## Interfaces

### AssemblyAITtsOptions

**`Input`**

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

##### host?

```ts
optional host?: string;
```

Streaming-TTS host to dial, replacing `ASSEMBLYAI_TTS_HOST` (US). A bare
host, not a URL — the adapter owns the `wss://` scheme and the `/v1/ws`
path, so a full URL here would be wrong in a way that only shows up at
connect.

`"tts.eu.assemblyai.com"` is EU residency (`assemblyAIPipeline({ region:
"eu" })` sets it). Any other value is a pre-release/staging cluster; one
generally issues its own keys, so point every AssemblyAI stage at the same
environment or the ones left on production reject the key.

##### language?

```ts
optional language?: "en" | "fr" | "de" | "it" | "pt" | "es";
```

Spoken language as an ISO 639-1 code (`"en"`, `"fr"`, `"de"`, `"es"`,
`"it"`, `"pt"`). Omitted by default, which the service reads as English.
Translated internally to the service's language name; see
[ASSEMBLYAI\_TTS\_LANGUAGES](#assemblyai_tts_languages) for the supported set. An unsupported
code fails at build and connect time rather than muting the session.

##### voice?

```ts
optional voice?: AssemblyAITtsVoice;
```

The `voice_id`: a library slug such as `"aai-jane"`, `"aai-michael"` or
`"aai-vera"` (see [ASSEMBLYAI\_TTS\_VOICES](#assemblyai_tts_voices)), or any other voice slug or
UUID the service knows. Defaults to [ASSEMBLYAI\_TTS\_DEFAULT\_VOICE](#assemblyai_tts_default_voice).
Every library voice speaks every supported language.

***

### CartesiaTtsOptions

**`Input`**

Options for [cartesiaTts](#cartesiatts).

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

### RimeTtsOptions

**`Input`**

Options for [rimeTts](#rimetts).

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

ISO 639-1 code for a language AssemblyAI streaming TTS speaks.

***

### AssemblyAITtsVoice

```ts
type AssemblyAITtsVoice = 
  | "aai-alba"
  | "aai-anna"
  | "aai-charles"
  | "aai-eve"
  | "aai-george"
  | "aai-jane"
  | "aai-jean"
  | "aai-mary"
  | "aai-michael"
  | "aai-paul"
  | "aai-vera"
  | string & {
};
```

A `voice_id`: a slug from [ASSEMBLYAI\_TTS\_VOICES](#assemblyai_tts_voices), or any other slug or
voice UUID the service knows.

The `(string & {})` arm is deliberate: the catalog is the service's, not
ours, so a voice added after this release, an open-dataset voice, or the
author's own cloned voice must still compile. **So this type is
AUTOCOMPLETE, not a guard** — an unlisted voice is warned about at build
time (`assemblyAIVoiceWarning`), never refused.

## Variables

### ASSEMBLYAI\_TTS\_DEFAULT\_VOICE

```ts
const ASSEMBLYAI_TTS_DEFAULT_VOICE: AssemblyAITtsVoice;
```

Default voice when `assemblyAITts()` is called with no `voice` — the
service's own default, so leaving it unset and naming it are the same session.

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

Keys are the six languages every library voice speaks.

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

### ASSEMBLYAI\_TTS\_VOICES

```ts
const ASSEMBLYAI_TTS_VOICES: readonly AssemblyAITtsVoice[];
```

The AssemblyAI library voices, as the `voice_id` slugs the service takes.

Source: https://www.assemblyai.com/docs/tts/voices. **Every one of them speaks
all six languages** — `language` picks what a voice speaks, the voice only how
it sounds — so there is no voice/language pairing to get wrong.

A list rather than a map because a slug is all there is to know about one,
and a list is what `z.enum` takes: a form offering the caller a voice is
`z.enum(ASSEMBLYAI_TTS_VOICES)`. Typed as a plain array, not a literal
tuple, so a voice added to the catalog is not a type change a reader's
exhaustive check breaks on.

A constant rather than a sentence in a doc comment because a wrong voice id
is a refusal the service sends after the upgrade (`3012 voice_not_found`), so
nothing at authoring time can tell a typo from a working agent except a list
to check it against. The service's own list (`GET /v1/voices`) has thousands
of open-dataset voices beside these; any of their slugs, a cloned voice's
slug, or a voice UUID is a valid `voice` too.

***

### CARTESIA\_DEFAULT\_VOICE

```ts
const CARTESIA_DEFAULT_VOICE: string;
```

Default voice used when callers invoke `cartesiaTts()` with no `voice`. This
is the same voice the example templates ship with, so a bare `cartesiaTts()`
works out of the box for new agents.

***

### RIME\_DEFAULT\_VOICE

```ts
const RIME_DEFAULT_VOICE: string;
```

Default Rime speaker used when callers invoke `rimeTts()` with no `voice`.
`cove` is a `mistv2` speaker, matching the default model below — so a
bare `rimeTts()` works out of the box for new agents.

## References

### fallback

Re-exports [fallback](stt.md#fallback)

***

### ProviderCredentialOptions

Re-exports [ProviderCredentialOptions](index.md#providercredentialoptions)

***

### TtsProvider

Re-exports [TtsProvider](index.md#ttsprovider)
