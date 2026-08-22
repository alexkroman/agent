# stt

`@alexkroman1/aai/stt` subpath barrel — the speech-to-text stage of a
pipeline agent.

Four vendors, one shape: each factory returns a serializable DESCRIPTOR
(`{ kind, options }`), and you hand it to `agent({ stt })`. Nothing here
opens a socket or reads a credential — the host resolves the descriptor at
session start, so importing this barrel pulls in no vendor SDK.

## Example

**Swap the STT stage of an otherwise default agent**

```ts
import { agent } from "@alexkroman1/aai";
import { deepgram } from "@alexkroman1/aai/stt";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  // `llm` and `tts` keep their AssemblyAI defaults.
  stt: deepgram({ model: "nova-3", language: "en" }),
});
```

**Credentials are never passed here.** Each factory's vendor names the env
var its key is read from — `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`,
`ELEVENLABS_API_KEY`, `SONIOX_API_KEY`, each also exported as a
`*_API_KEY_ENV` constant — and the host reads it out of the agent's own
environment when the session starts. That is what keeps a descriptor safe to
serialize across the CLI → server → guest boundary.

## What an unset language means, per vendor

The field is spelled the way each vendor spells it on the wire, so the four
do not line up — and neither do their defaults. This is the one
cross-provider fact you cannot assemble from the per-symbol docs, and the
row that surprises people is Deepgram's:

| factory | field | unset means |
| --- | --- | --- |
| [assemblyAIStt](#assemblyaistt) | `languages` | detect per turn (code-switches across 18) |
| [deepgram](#deepgram) | `language` | **English** — `"en"` is sent for you |
| [elevenlabs](#elevenlabs) | `languageCode` | auto-detect (the field is omitted) |
| [soniox](#soniox) | `languageHints` | auto-detect (the field is omitted) |

So moving an agent from [assemblyAIStt](#assemblyaistt) to [deepgram](#deepgram) silently
drops multilingual transcription, and moving the other way silently gains
code-switching — read [AssemblyAIOptions.languages](#languages) before you do,
because that default has a measured failure mode with no obvious symptom.

## The host-side opener contract is on `/runtime`

Implementing an STT vendor of your own — `SttOpenOptions`, `SttSession`,
`SttEvents`, `SttError`, `SttTurnMeta`, `Unsubscribe` — is a HOST job, and
those types live on `@alexkroman1/aai-runtime` beside `registerSttKind`,
which is what you hand the opener to. Only [SttProvider](#sttprovider), the
descriptor a factory here returns, stays on this page.

## Functions

### assemblyAIStt()

```ts
function assemblyAIStt(opts?: AssemblyAIOptions): AssemblyAIProvider;
```

Build an AssemblyAI STT descriptor.

The API key is resolved host-side from the agent's env
(`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

Named `assemblyAIStt` (not `assemblyAI`) so the STT, LLM
(`assemblyAILlm`), and TTS (`assemblyAITts`) factories can be imported
side by side without aliasing.

#### Parameters

##### opts?

[`AssemblyAIOptions`](#assemblyaioptions)

#### Returns

[`AssemblyAIProvider`](#assemblyaiprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAIStt } from "@alexkroman1/aai/stt";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  stt: assemblyAIStt({ languages: ["en"] }),
});
```

Pinning `languages` to one code turns code-switching OFF. Unset means
"detect per turn", which is not "English" — see
[AssemblyAIOptions.languages](#languages).

***

### deepgram()

```ts
function deepgram(opts?: DeepgramOptions): DeepgramProvider;
```

Build a Deepgram STT descriptor.

The API key is resolved host-side from the agent's env
(`DEEPGRAM_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

#### Parameters

##### opts?

[`DeepgramOptions`](#deepgramoptions)

#### Returns

[`DeepgramProvider`](#deepgramprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { deepgram } from "@alexkroman1/aai/stt";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  stt: deepgram({ model: "nova-3", language: "en" }),
});
```

Deepgram is the one STT vendor here whose unset `language` is not
auto-detect: `"en"` is sent for you. Name the code you mean.

***

### elevenlabs()

```ts
function elevenlabs(opts?: ElevenLabsOptions): ElevenLabsProvider;
```

Build an ElevenLabs Scribe STT descriptor.

The API key is resolved host-side from the agent's env
(`ELEVENLABS_API_KEY`); there is no factory-time key parameter, so
the descriptor stays free of secrets and safe to serialize.

#### Parameters

##### opts?

[`ElevenLabsOptions`](#elevenlabsoptions)

#### Returns

[`ElevenLabsProvider`](#elevenlabsprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { elevenlabs } from "@alexkroman1/aai/stt";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  stt: elevenlabs({ model: "scribe_v2_realtime", languageCode: "en" }),
});
```

Unset, `languageCode` is omitted from the request and Scribe
auto-detects — which is not the same as English.

***

### soniox()

```ts
function soniox(opts?: SonioxOptions): SonioxProvider;
```

Build a Soniox STT descriptor.

The API key is resolved host-side from the agent's env
(`SONIOX_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

#### Parameters

##### opts?

[`SonioxOptions`](#sonioxoptions)

#### Returns

[`SonioxProvider`](#sonioxprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { soniox } from "@alexkroman1/aai/stt";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  stt: soniox({ model: "stt-rt-v3", languageHints: ["en", "es"] }),
});
```

Unset, `languageHints` is omitted from the request and Soniox
auto-detects — which is not the same as English.

## Interfaces

### AssemblyAIOptions

Options for [assemblyAIStt](#assemblyaistt).

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

**Only the three AssemblyAI stages carry this field, and that is
deliberate.** The host reads `apiKeyEnv` off a descriptor generically
(the host reads it generically), so adding it to `deepgram`, `elevenlabs`,
`soniox`, `cartesia`, `rime` or any LLM vendor would be one line each and
work — but none of them has the problem it solves. AssemblyAI keys are
ENVIRONMENT-SCOPED, so a staging cluster and production need two live keys
at once and a per-stage override is the only way to run a mixed pipeline.
Every other vendor here has one account-wide key, which the provider
default already names.

##### connectTimeoutMs?

```ts
optional connectTimeoutMs?: number;
```

Deadline for one streaming connect attempt — socket open *and* the
server's `Begin` message. Defaults to `STT_CONNECT_TIMEOUT_MS`
(2500 ms), overriding the SDK's own 1000 ms, which a healthy handshake
can exceed. `0` waits indefinitely.

##### languages?

```ts
optional languages?: string[];
```

Languages to bias the model toward, sent as the `language_codes` connection
parameter (e.g. `["en"]`, `["en", "es"]`).

**Unset means DETECT PER TURN, not English** — the same default
`elevenlabs` and `soniox` have, and the opposite of `deepgram`, whose
unset `language` is `"en"`.

Universal-3.5 Pro **code-switches across 18 languages by default**, so an
unset value costs accuracy on a monolingual line in a way that is easy to
misread as an audio problem: measured against tau2-bench, English
utterances came back
transliterated into Devanagari and Hebrew script
(`Hello? Any update?` → `हेलो एनी अपडेट`), including an authentication turn,
so the tool call built from it was garbage. Nothing in the transcript says
"wrong language" — it reads as a mis-hearing.

A single-element list pins one language and keeps code-switching off; omit
for a genuinely multilingual line.

##### maxConnectRetries?

```ts
optional maxConnectRetries?: number;
```

Extra connect attempts after a transient failure (timeout, network drop,
unexpected close); permanent failures such as auth are never retried.
Defaults to `STT_CONNECT_MAX_RETRIES` (2). `0` disables retries.

Raising either knob widens the worst-case open time
(`(1 + retries) * connectTimeoutMs` plus the retry delays), which has to
stay under `DEFAULT_SESSION_START_TIMEOUT_MS` — see the connect-budget
note in `sdk/constants.ts`.

##### maxTurnSilenceMs?

```ts
optional maxTurnSilenceMs?: number;
```

Maximum silence (ms) before the service force-ends a turn regardless of
content, sent as the `max_turn_silence` connection parameter. This is the
pause-tolerance knob: it bounds only utterances that never read as
complete, so raising it costs an ordinary finished sentence nothing.
Defaults to `DEFAULT_MAX_TURN_SILENCE_MS` (3000); the service's own default
is 1536. Raise it for callers who dictate confirmation numbers or
addresses, and keep it above [minTurnSilenceMs](#minturnsilencems).

##### minTurnSilenceMs?

```ts
optional minTurnSilenceMs?: number;
```

Silence (ms) before the service runs its end-of-turn check, sent as the
`min_turn_silence` connection parameter. At this point the model asks
whether the turn reads as COMPLETE — if it does the turn ends, if not a
partial is emitted and the turn stays open. So this is the latency floor on
utterances that really did finish. Defaults to
`DEFAULT_MIN_TURN_SILENCE_MS` (1600).

To tolerate longer mid-utterance pauses, raise [maxTurnSilenceMs](#maxturnsilencems)
instead — and never above it. This is a minimum and that is a maximum, so a
value above the ceiling means the check can never fire before the
content-blind force-end closes the turn, which is the split this knob is
usually reached for in order to prevent.

##### model?

```ts
optional model?: string;
```

Streaming speech model. Defaults to `"universal-3-5-pro"` (Universal-3.5
Pro Real-Time). Arbitrary strings are forwarded to the SDK unchanged.

##### region?

```ts
optional region?: "us" | "eu";
```

EU data-residency — routes both streaming and sync transcription to
AssemblyAI's EU endpoints (`streaming.eu.assemblyai.com` /
`sync.eu.assemblyai.com`). Required for EU-region API keys, which the US
endpoints reject. Defaults to `"us"`.

##### streamingUrl?

```ts
optional streamingUrl?: string;
```

Streaming WebSocket endpoint override, sent as the SDK's
`websocketBaseUrl`. Must include the versioned path (e.g.
`wss://streaming.sandbox000.assemblyai-labs.com/v3/ws`) — the SDK only
supplies that path for its own default host, so a bare origin connects to
the wrong route.

Takes precedence over [AssemblyAIOptions.region](#region): an explicit
endpoint is a deliberate choice and must not be silently overwritten by
the residency shorthand. Intended for pre-release/staging clusters and
A/B measurement against the default host; leave unset in production.

##### voiceFocus?

```ts
optional voiceFocus?: string;
```

Voice focus (voice isolation) mode, sent as the `voice_focus` connection
parameter. Defaults to `"near-field"` to suppress background noise for
close-mic / phone audio. Set to `""` (or `"off"`) to disable.

##### voiceFocusThreshold?

```ts
optional voiceFocusThreshold?: number;
```

How aggressively Voice Focus suppresses background audio, sent as the
`voice_focus_threshold` connection parameter (0-1, higher is more
aggressive). Defaults to `DEFAULT_VOICE_FOCUS_THRESHOLD` (0.9), above the
service's own 0.7.

Raise it when BACKGROUND SPEECH — a television, a radio, another
conversation — is reaching the transcript. That is the case the default is
tuned for, and the case no VAD setting can fix: those frames really are
speech, so a frame gate cannot distinguish them from the caller (see the
constant's doc for the measurement). Lower it if the caller's own quiet or
distant speech is being suppressed.

Ignored when [voiceFocus](#voicefocus) is off — it tunes that filter.

***

### DeepgramOptions

Options for [deepgram](#deepgram).

#### Properties

##### endpointing?

```ts
optional endpointing?: number;
```

Deepgram endpointing window (ms of trailing silence before a `final` is
emitted). Defaults to [DEFAULT\_DEEPGRAM\_ENDPOINTING\_MS](#default_deepgram_endpointing_ms). Endpointing
is the provider's job — the pipeline transport commits a turn on every
final — so this window is what keeps a mid-utterance pause from splitting
one request across turns.

##### language?

```ts
optional language?: string;
```

BCP-47 language code for transcription. Examples: `"en"`, `"es"`, `"fr"`,
`"de"`.

**Unset means ENGLISH, not auto-detect.** Deepgram is the one STT provider
here that behaves that way: `DEEPGRAM_DEFAULT_LANGUAGE` (`"en"`) is
filled in and sent on every connection, where `assemblyAIStt` detects per
turn and `elevenlabs`/`soniox` omit the field entirely so the vendor
auto-detects. So an agent moved from any of those three to `deepgram()`
silently loses non-English transcription — and the symptom is a caller
whose speech comes back as plausible English words, which reads as a
mis-hearing rather than as a language setting.

Name the code you mean. There is no value for "detect": Deepgram's
multilingual support is selected by naming a multilingual `model`.

##### model?

```ts
optional model?: string;
```

Streaming speech model. Defaults to `"nova-3"`. Any string is forwarded
to the SDK unchanged, which allows opt-in to future models.

***

### ElevenLabsOptions

Options for [elevenlabs](#elevenlabs).

#### Properties

##### languageCode?

```ts
optional languageCode?: string;
```

BCP-47 language code hint. Passing one reduces ambiguity for short
utterances.

**Unset means AUTO-DETECT, not English.** The field is omitted from the
request entirely, so ElevenLabs decides — which is the same default
`assemblyAIStt` and `soniox` have, and the opposite of `deepgram`, whose
unset `language` is `"en"`. Pass a code for a line you know is
monolingual.

##### model?

```ts
optional model?: string;
```

Streaming speech model. Defaults to `"scribe_v2_realtime"`. Any
string is forwarded to the SDK unchanged so users can opt in to
future models without an SDK release.

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

### SonioxOptions

Options for [soniox](#soniox).

#### Properties

##### languageHints?

```ts
optional languageHints?: readonly string[];
```

Language hints (ISO 639-1 codes) that bias decoding toward the expected
languages. Example: `["en", "es"]`.

**Unset means AUTO-DETECT, not English.** The field is omitted from the
request entirely, so Soniox decides — which is the same default
`assemblyAIStt` and `elevenlabs` have, and the opposite of `deepgram`,
whose unset `language` is `"en"`. Pass the codes for a line you know is
monolingual, or the handful you expect on one that is not.

##### model?

```ts
optional model?: string;
```

Streaming model. Defaults to `"stt-rt-v3"`. Any string is forwarded
verbatim so users can opt in to future models.

## Type Aliases

### AssemblyAIProvider

```ts
type AssemblyAIProvider = SttProvider & {
  kind: typeof ASSEMBLYAI_KIND;
  options: AssemblyAIOptions;
};
```

Descriptor returned by [assemblyAIStt](#assemblyaistt).

#### Type Declaration

##### kind

```ts
readonly kind: typeof ASSEMBLYAI_KIND;
```

##### options

```ts
readonly options: AssemblyAIOptions;
```

***

### DeepgramProvider

```ts
type DeepgramProvider = SttProvider & {
  kind: typeof DEEPGRAM_KIND;
  options: DeepgramOptions;
};
```

Descriptor returned by [deepgram](#deepgram).

#### Type Declaration

##### kind

```ts
readonly kind: typeof DEEPGRAM_KIND;
```

##### options

```ts
readonly options: DeepgramOptions;
```

***

### ElevenLabsProvider

```ts
type ElevenLabsProvider = SttProvider & {
  kind: typeof ELEVENLABS_KIND;
  options: ElevenLabsOptions;
};
```

Descriptor returned by [elevenlabs](#elevenlabs).

#### Type Declaration

##### kind

```ts
readonly kind: typeof ELEVENLABS_KIND;
```

##### options

```ts
readonly options: ElevenLabsOptions;
```

***

### SonioxProvider

```ts
type SonioxProvider = SttProvider & {
  kind: typeof SONIOX_KIND;
  options: SonioxOptions;
};
```

Descriptor returned by [soniox](#soniox).

#### Type Declaration

##### kind

```ts
readonly kind: typeof SONIOX_KIND;
```

##### options

```ts
readonly options: SonioxOptions;
```

***

### SttProvider

```ts
type SttProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  __stage?: "stt";
};
```

Descriptor for an STT provider. Returned by factories like
`assemblyAIStt(...)` from `@alexkroman1/aai/stt`.

#### Type Declaration

##### \_\_stage?

```ts
readonly optional __stage?: "stt";
```

Compile-time stage tag; never present at runtime.

## Variables

### ASSEMBLYAI\_API\_KEY\_ENV

```ts
const ASSEMBLYAI_API_KEY_ENV: "ASSEMBLYAI_API_KEY" = "ASSEMBLYAI_API_KEY";
```

Agent-env variable holding the AssemblyAI API key.

***

### ASSEMBLYAI\_KIND

```ts
const ASSEMBLYAI_KIND: "assemblyai";
```

Kind tag recognised by the host-side resolver.

***

### ASSEMBLYAI\_STREAMING\_EU\_URL

```ts
const ASSEMBLYAI_STREAMING_EU_URL: "wss://streaming.eu.assemblyai.com/v3/ws" = "wss://streaming.eu.assemblyai.com/v3/ws";
```

EU data-residency streaming endpoint.

***

### DEEPGRAM\_API\_KEY\_ENV

```ts
const DEEPGRAM_API_KEY_ENV: "DEEPGRAM_API_KEY" = "DEEPGRAM_API_KEY";
```

Agent-env variable holding the Deepgram API key.

***

### DEEPGRAM\_KIND

```ts
const DEEPGRAM_KIND: "deepgram";
```

Kind tag recognised by the host-side resolver.

***

### DEFAULT\_DEEPGRAM\_ENDPOINTING\_MS

```ts
const DEFAULT_DEEPGRAM_ENDPOINTING_MS: 1500 = 1500;
```

Default Deepgram `endpointing` (ms) — **the same knob as
`DEFAULT_MIN_TURN_SILENCE_MS`, seen from a different vendor.** The transport
commits a turn on every STT final, so end-of-turn detection is owned
entirely by the provider and a short window would commit a turn at every
mid-utterance pause.

#### See

 - `DEFAULT_MIN_TURN_SILENCE_MS` on `@alexkroman1/aai` — the AssemblyAI
opener's `min_turn_silence`, 1600 ms, the value this 1500 ms window is
matched to. Its doc carries the sweep that puts the knee there, and is the
one to read before moving either number.
 - `DEFAULT_MAX_TURN_SILENCE_MS` on `@alexkroman1/aai` — the AssemblyAI
opener's pause-tolerance ceiling. Deepgram exposes no counterpart: its
`endpointing` is a silence window with no completeness check, so there is
nothing here for a maximum to bound.

Named `DEFAULT_DEEPGRAM_…` rather than `DEEPGRAM_DEFAULT_…` like every other
provider constant, which is a wart and not worth a `major` on its own —
recorded here so the next reviewer does not re-derive it. `konsistent.json`
does not check it: the shared template only covers the `*_DEFAULT_MODEL`
shape.

***

### ELEVENLABS\_API\_KEY\_ENV

```ts
const ELEVENLABS_API_KEY_ENV: "ELEVENLABS_API_KEY" = "ELEVENLABS_API_KEY";
```

Agent-env variable holding the ElevenLabs API key.

***

### ELEVENLABS\_KIND

```ts
const ELEVENLABS_KIND: "elevenlabs";
```

Kind tag recognised by the host-side resolver.

***

### SONIOX\_API\_KEY\_ENV

```ts
const SONIOX_API_KEY_ENV: "SONIOX_API_KEY" = "SONIOX_API_KEY";
```

Agent-env variable holding the Soniox API key.

***

### SONIOX\_KIND

```ts
const SONIOX_KIND: "soniox";
```

Kind tag recognised by the host-side resolver.
