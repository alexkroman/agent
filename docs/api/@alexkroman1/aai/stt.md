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
import { deepgramStt } from "@alexkroman1/aai/stt";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  // `llm` and `tts` keep their AssemblyAI defaults.
  stt: deepgramStt({ model: "nova-3", language: "en" }),
});
```

**Credentials are never passed here.** Each factory's vendor names the env
var its key is read from — `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`,
`ELEVENLABS_API_KEY`, `SONIOX_API_KEY` — and the host reads it out of the
agent's own environment when the session starts. That is what keeps a
descriptor safe to serialize across the CLI → server → guest boundary. The
variable NAMES are not published: an author never types one, and the one
case for repointing a stage is `apiKeyEnv` on the AssemblyAI descriptor.

## What an unset language means, per vendor

The field is spelled `language` for a single code and `languages` for a
list, which is the only difference between the four — but their DEFAULTS do
not line up, and that is the one cross-provider fact you cannot assemble
from the per-symbol docs. The row that surprises people is Deepgram's:

| factory | field | unset means |
| --- | --- | --- |
| [assemblyAIStt](#assemblyaistt) | `languages` | detect per turn (code-switches across 18) |
| [deepgramStt](#deepgramstt) | `language` | **English** — `"en"` is sent for you |
| [elevenLabsStt](#elevenlabsstt) | `language` | auto-detect (the field is omitted) |
| [sonioxStt](#sonioxstt) | `languages` | auto-detect (the field is omitted) |

So moving an agent from [assemblyAIStt](#assemblyaistt) to [deepgramStt](#deepgramstt) silently
drops multilingual transcription, and moving the other way silently gains
code-switching — read [AssemblyAISttOptions.languages](#languages) before you do,
because that default has a measured failure mode with no obvious symptom.

Each vendor's own wire spelling (`language_codes`, `languageCode`,
`language_hints`) is applied by the host opener, not written here.

## The descriptor type is on the ROOT barrel TOO

`SttProvider` — what a factory here returns — is also exported from
`@alexkroman1/aai`, beside the other three stage types, so an agent
annotating two stages writes one import rather than two. It stays here as
well: this is where the factory that produces one lives.
`ProviderDescriptor`, the base all four narrow, is on the root ALONE now —
one interface with four reference pages was three too many.

## The host-side opener contract is on `/runtime`

Implementing an STT vendor of your own — `SttOpenOptions`, `SttSession`,
`SttEvents`, `SttError`, `SttTurnMeta`, `Unsubscribe` — is a HOST job, and
those types live on `@alexkroman1/aai-runtime` beside `registerSttKind`,
which is what you hand the opener to.

## Functions

### assemblyAIStt()

```ts
function assemblyAIStt(options?: AssemblyAISttOptions): SttProvider;
```

Build an AssemblyAI STT descriptor.

The API key is resolved host-side from the agent's env
(`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

Named `assemblyAIStt` (not `assemblyAI`) so the STT, LLM
(`assemblyAILlm`), and TTS (`assemblyAITts`) factories can be imported
side by side without aliasing.

#### Parameters

##### options?

[`AssemblyAISttOptions`](#assemblyaisttoptions)

#### Returns

[`SttProvider`](index.md#sttprovider)

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
[AssemblyAISttOptions.languages](#languages).

***

### deepgramStt()

```ts
function deepgramStt(options?: DeepgramSttOptions): SttProvider;
```

Build a Deepgram STT descriptor.

The API key is resolved host-side from the agent's env
(`DEEPGRAM_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

#### Parameters

##### options?

[`DeepgramSttOptions`](#deepgramsttoptions)

#### Returns

[`SttProvider`](index.md#sttprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { deepgramStt } from "@alexkroman1/aai/stt";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  stt: deepgramStt({ model: "nova-3", language: "en" }),
});
```

Deepgram is the one STT vendor here whose unset `language` is not
auto-detect: `"en"` is sent for you. Name the code you mean.

***

### elevenLabsStt()

```ts
function elevenLabsStt(options?: ElevenLabsSttOptions): SttProvider;
```

Build an ElevenLabs Scribe STT descriptor.

The API key is resolved host-side from the agent's env
(`ELEVENLABS_API_KEY`); there is no factory-time key parameter, so
the descriptor stays free of secrets and safe to serialize.

#### Parameters

##### options?

[`ElevenLabsSttOptions`](#elevenlabssttoptions)

#### Returns

[`SttProvider`](index.md#sttprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { elevenLabsStt } from "@alexkroman1/aai/stt";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  stt: elevenLabsStt({ model: "scribe_v2_realtime", language: "en" }),
});
```

Unset, `language` is omitted from the request and Scribe
auto-detects — which is not the same as English.

***

### sonioxStt()

```ts
function sonioxStt(options?: SonioxSttOptions): SttProvider;
```

Build a Soniox STT descriptor.

The API key is resolved host-side from the agent's env
(`SONIOX_API_KEY`); there is no factory-time key parameter, so the
descriptor stays free of secrets and safe to serialize.

#### Parameters

##### options?

[`SonioxSttOptions`](#sonioxsttoptions)

#### Returns

[`SttProvider`](index.md#sttprovider)

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { sonioxStt } from "@alexkroman1/aai/stt";

export default agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  stt: sonioxStt({ model: "stt-rt-v3", languages: ["en", "es"] }),
});
```

Unset, `languages` is omitted from the request and Soniox
auto-detects — which is not the same as English.

## Interfaces

### AssemblyAISttOptions

Options for [assemblyAIStt](#assemblyaistt).

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
`elevenlabs` and `sonioxStt` have, and the opposite of `deepgramStt`, whose
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

Takes precedence over [AssemblyAISttOptions.region](#region): an explicit
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

### DeepgramSttOptions

Options for [deepgramStt](#deepgramstt).

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

##### endpointing?

```ts
optional endpointing?: number;
```

Deepgram endpointing window (ms of trailing silence before a `final` is
emitted). Defaults to [DEEPGRAM\_DEFAULT\_ENDPOINTING\_MS](#deepgram_default_endpointing_ms). Endpointing
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
turn and `elevenlabs`/`sonioxStt` omit the field entirely so the vendor
auto-detects. So an agent moved from any of those three to `deepgramStt()`
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

### ElevenLabsSttOptions

Options for [elevenLabsStt](#elevenlabsstt).

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

BCP-47 language code hint. Passing one reduces ambiguity for short
utterances.

**Unset means AUTO-DETECT, not English.** The field is omitted from the
request entirely, so ElevenLabs decides — which is the same default
`assemblyAIStt` and `sonioxStt` have, and the opposite of `deepgramStt`, whose
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

### SonioxSttOptions

Options for [sonioxStt](#sonioxstt).

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

##### languages?

```ts
optional languages?: readonly string[];
```

Language codes (ISO 639-1) that bias decoding toward the expected
languages, sent as Soniox's `language_hints`. Example: `["en", "es"]`.

**Unset means AUTO-DETECT, not English.** The field is omitted from the
request entirely, so Soniox decides — which is the same default
`assemblyAIStt` and `elevenlabs` have, and the opposite of `deepgramStt`,
whose unset `language` is `"en"`. Pass the codes for a line you know is
monolingual, or the handful you expect on one that is not.

##### model?

```ts
optional model?: string;
```

Streaming model. Defaults to `"stt-rt-v3"`. Any string is forwarded
verbatim so users can opt in to future models.

## Variables

### ASSEMBLYAI\_STT\_EU\_URL

```ts
const ASSEMBLYAI_STT_EU_URL: "wss://streaming.eu.assemblyai.com/v3/ws" = "wss://streaming.eu.assemblyai.com/v3/ws";
```

EU data-residency streaming endpoint.

***

### DEEPGRAM\_DEFAULT\_ENDPOINTING\_MS

```ts
const DEEPGRAM_DEFAULT_ENDPOINTING_MS: 1500 = 1500;
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

`konsistent.json` does not check the name: the shared template only covers
the `*_DEFAULT_MODEL` and `*_DEFAULT_VOICE` shapes.

## References

### ProviderCredentialOptions

Re-exports [ProviderCredentialOptions](index.md#providercredentialoptions)

***

### SttProvider

Re-exports [SttProvider](index.md#sttprovider)
