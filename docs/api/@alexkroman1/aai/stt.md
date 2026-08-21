# stt

`@alexkroman1/aai/stt` subpath barrel.

Re-exports the descriptor factories (`assemblyAIStt`, `deepgram`,
`elevenlabs`, `soniox`) and the shared STT contract types. Importing this
barrel does not pull in the `assemblyai` SDK — that happens only when the
host resolver is invoked.

Named re-exports rather than `export *`: the wildcard form needs a
`noReExportAll` suppression per line, and the escape-hatch ratchet only
moves down. Listing them also makes the public surface of this subpath
readable in one place — add new symbols here when a provider gains one.

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

Universal-3.5 Pro **code-switches across 18 languages by default**, so an
unset value is not "English" — it is "detect per turn". That default costs
accuracy on a monolingual line in a way that is easy to misread as an audio
problem: measured against tau2-bench, English utterances came back
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

BCP-47 language code for transcription. Defaults to `"en"`.
Examples: `"en"`, `"es"`, `"fr"`, `"de"`.

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

BCP-47 language code hint. ElevenLabs auto-detects when omitted;
passing a hint reduces ambiguity for short utterances.

##### model?

```ts
optional model?: string;
```

Streaming speech model. Defaults to `"scribe_v2_realtime"`. Any
string is forwarded to the SDK unchanged so users can opt in to
future models without an SDK release.

***

### SonioxOptions

Options for [soniox](#soniox).

#### Properties

##### languageHints?

```ts
optional languageHints?: readonly string[];
```

Language hints (ISO 639-1 codes) that bias decoding toward the
expected languages. Optional; auto-detection is used when omitted.
Example: `["en", "es"]`.

##### model?

```ts
optional model?: string;
```

Streaming model. Defaults to `"stt-rt-v3"`. Any string is forwarded
verbatim so users can opt in to future models.

***

### SttError

Error raised by an STT provider stream, with a typed `code` naming the
failure phase: connecting, authenticating, or mid-stream.

#### Extends

- `Error`

#### Properties

##### cause?

```ts
optional cause?: unknown;
```

###### Inherited from

```ts
Error.cause
```

##### code

```ts
readonly code: "stt_connect_failed" | "stt_auth_failed" | "stt_stream_error";
```

##### message

```ts
message: string;
```

###### Inherited from

```ts
Error.message
```

##### name

```ts
name: string;
```

###### Inherited from

```ts
Error.name
```

##### stack?

```ts
optional stack?: string;
```

###### Inherited from

```ts
Error.stack
```

***

### SttOpenOptions

Options the host passes when opening an STT stream.

#### Properties

##### agentContext?

```ts
optional agentContext?: string;
```

Initial agent-side context to seed at connect time (e.g. the opening
greeting), for providers that support it. Providers that don't support
it, or whose resolved model doesn't qualify, ignore this.

##### apiKey

```ts
apiKey: string;
```

Provider API key, resolved from the agent's env.

##### sampleRate

```ts
sampleRate: number;
```

Capture sample rate of the inbound PCM, in Hz.

##### signal

```ts
signal: AbortSignal;
```

##### sttPrompt?

```ts
optional sttPrompt?: string;
```

***

### SttSession

Host-side handle to one open STT provider stream (pipeline mode). Produced
by the host's provider resolver at session start; user code never
constructs one.

#### Methods

##### close()

```ts
close(): Promise<void>;
```

###### Returns

`Promise`\<`void`\>

##### on()

```ts
on<E>(event: E, fn: SttEvents[E]): Unsubscribe;
```

###### Type Parameters

###### E

`E` *extends* keyof [`SttEvents`](#sttevents)

###### Parameters

###### event

`E`

###### fn

[`SttEvents`](#sttevents)\[`E`\]

###### Returns

[`Unsubscribe`](#unsubscribe)

##### sendAudio()

```ts
sendAudio(pcm: Int16Array): void;
```

Push one PCM16 audio frame from the client into the transcriber.

###### Parameters

###### pcm

`Int16Array`

###### Returns

`void`

##### updateAgentContext()?

```ts
optional updateAgentContext(text: string): void;
```

Push the agent's latest reply text mid-stream so the next user turn is
transcribed with that context (e.g. AssemblyAI's `agent_context`, gated
to models that support it). Optional: providers that have no equivalent
simply omit it, and callers must use `?.()` to invoke it.

###### Parameters

###### text

`string`

###### Returns

`void`

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

### SttEvents

```ts
type SttEvents = {
  error: (err: SttError) => void;
  final: (text: string, meta?: SttTurnMeta) => void;
  partial: (text: string, meta?: SttTurnMeta) => void;
};
```

#### Properties

##### error

```ts
error: (err: SttError) => void;
```

Terminal error. The session is expected to end after this fires.

###### Parameters

###### err

[`SttError`](#stterror)

###### Returns

`void`

##### final

```ts
final: (text: string, meta?: SttTurnMeta) => void;
```

End-of-turn final transcript; cue to run the LLM.

###### Parameters

###### text

`string`

###### meta?

[`SttTurnMeta`](#sttturnmeta)

###### Returns

`void`

##### partial

```ts
partial: (text: string, meta?: SttTurnMeta) => void;
```

Interim transcript; drives barge-in detection.

###### Parameters

###### text

`string`

###### meta?

[`SttTurnMeta`](#sttturnmeta)

###### Returns

`void`

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

***

### SttTurnMeta

```ts
type SttTurnMeta = {
  endOfTurnConfidence?: number;
};
```

Provider-reported detail about the turn a transcript belongs to.

Optional throughout: every field is something a given provider may not
report, and a consumer must treat `undefined` as "no opinion" rather than
as a low value. Passed alongside the text rather than folded into it so
that a provider gaining a signal does not change any existing call site.

#### Properties

##### endOfTurnConfidence?

```ts
optional endOfTurnConfidence?: number;
```

The service's confidence that the user's turn has ENDED, 0..1, as of this
transcript. AssemblyAI reports it per interim turn
(`end_of_turn_confidence`); providers that do not report it omit it.

It rises as an utterance settles and resets when the caller resumes, so a
dictated identifier produces a sawtooth rather than a ramp — observed on
a spoken phone number: `0, 0.25, 0` across revisions of the same prefix,
then `0 → 0.25 → 0.4 → 0.55 → 0.7 → 0.8 → 0.95 → 1` once the full number
had landed. That shape is why it is worth having: the silence-window
knobs (`min_turn_silence`) decide end-of-turn on elapsed time alone and
cannot tell "paused between digits" from "finished", which is the
mechanism that truncates a spelled identifier mid-entity.

One policy reads it today: PREEMPTIVE GENERATION
(`AgentDef.preemptiveGeneration`, OFF by default), which starts a
speculative LLM stream from an interim whose confidence clears
`PREEMPTIVE_CONFIDENCE_THRESHOLD`. The sawtooth above is not
background for that policy — it DICTATED two of its rules, and both are
only defensible while the trace stays here. (1) A partial whose normalized
text differs from the live speculation's prompt aborts it immediately, so a
false peak partway through a dictated identifier dies on the next digit
instead of being billed in full. (2) An identical text at rising confidence
never re-fires, which is what the terminal `0.95 → 1` re-emission above
would otherwise cost on every completed utterance. Endpointing itself is
still time-based and unchanged; a confidence-aware endpointing or barge-in
policy remains unbuilt, and this field is still what would let one be
measured against the current one rather than guessed at.

***

### Unsubscribe

```ts
type Unsubscribe = () => void;
```

Unsubscribe callback returned by `.on()` event subscriptions.

#### Returns

`void`

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

Default Deepgram `endpointing` (ms). Matches the AssemblyAI opener's
`min_turn_silence` default (`DEFAULT_MIN_TURN_SILENCE_MS`): the transport
commits a turn on every STT final, so end-of-turn detection is owned
entirely by the provider and a short window would commit a turn at every
mid-utterance pause.

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
