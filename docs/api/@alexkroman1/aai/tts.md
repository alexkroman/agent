# tts

`@alexkroman1/aai/tts` subpath barrel.

Re-exports the descriptor factories (`assemblyAITts`, `cartesia`, `rime`)
and the shared TTS contract types. Does not pull in any provider SDK — the
host resolver handles that at session start.

Named re-exports rather than `export *`: the wildcard form needs a
`noReExportAll` suppression per line, and the escape-hatch ratchet only
moves down. Listing them also makes the public surface of this subpath
readable in one place — add new symbols here when a provider gains one.

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
language — see [ASSEMBLYAI\_TTS\_VOICES](#assemblyai_tts_voices) for the catalog.

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

***

### TtsError

Error raised by a TTS provider stream, with a typed `code` naming the
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
readonly code: "tts_connect_failed" | "tts_auth_failed" | "tts_stream_error";
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

### TtsOpenOptions

Options the host passes when opening a TTS stream.

#### Properties

##### apiKey

```ts
apiKey: string;
```

Provider API key, resolved from the agent's env.

##### sampleRate

```ts
sampleRate: number;
```

Playback sample rate of the synthesized PCM, in Hz.

##### signal

```ts
signal: AbortSignal;
```

Aborts the open (and the session) when the voice session ends.

***

### TtsSession

Host-side handle to one open TTS provider stream (pipeline mode). Produced
by the host's provider resolver at session start; user code never
constructs one.

#### Methods

##### cancel()

```ts
cancel(): void;
```

Interrupt immediately (barge-in). Emits `done` synchronously.

###### Returns

`void`

##### close()

```ts
close(): Promise<void>;
```

###### Returns

`Promise`\<`void`\>

##### flush()

```ts
flush(): void;
```

Signal "no more text this turn". Emits `done` when fully synthesized.

###### Returns

`void`

##### on()

```ts
on<E>(event: E, fn: TtsEvents[E]): Unsubscribe;
```

###### Type Parameters

###### E

`E` *extends* keyof [`TtsEvents`](#ttsevents)

###### Parameters

###### event

`E`

###### fn

[`TtsEvents`](#ttsevents)\[`E`\]

###### Returns

[`Unsubscribe`](stt.md#unsubscribe)

##### sendText()

```ts
sendText(text: string): void;
```

Push text deltas from the LLM. Provider may synthesize as chunks arrive.

###### Parameters

###### text

`string`

###### Returns

`void`

***

### TtsWordTiming

One synthesized word and where its audio sits in the current turn.

Offsets are milliseconds into THIS TURN's synthesized audio (the first
sample the provider produced for the turn is 0), not into the session, so
they line up with the transport's per-reply audio accounting. Providers that
report per-socket or per-flush clocks are rebased by their own adapter before
the event is emitted.

#### Properties

##### endMs

```ts
readonly endMs: number;
```

End offset of the word's audio, ms into the turn.

##### startMs

```ts
readonly startMs: number;
```

Start offset of the word's audio, ms into the turn.

##### text

```ts
readonly text: string;
```

The word as the provider synthesized it (may be normalized: "$5.00" → "five dollars").

## Type Aliases

### AssemblyAITtsLanguage

```ts
type AssemblyAITtsLanguage = keyof typeof ASSEMBLYAI_TTS_LANGUAGES;
```

ISO 639-1 code for a language the AssemblyAI voice catalog speaks.

***

### AssemblyAITtsProvider

```ts
type AssemblyAITtsProvider = TtsProvider & {
  kind: typeof ASSEMBLYAI_TTS_KIND;
  options: AssemblyAITtsOptions & {
     voice: string;
  };
};
```

Descriptor returned by [assemblyAITts](#assemblyaitts).

#### Type Declaration

##### kind

```ts
readonly kind: typeof ASSEMBLYAI_TTS_KIND;
```

##### options

```ts
readonly options: AssemblyAITtsOptions & {
  voice: string;
};
```

###### Type Declaration

###### voice

```ts
voice: string;
```

***

### AssemblyAITtsVoice

```ts
type AssemblyAITtsVoice = 
  | keyof typeof ASSEMBLYAI_TTS_VOICES
| string & Record<never, never>;
```

A voice id from [ASSEMBLYAI\_TTS\_VOICES](#assemblyai_tts_voices).

The `(string & {})` arm is deliberate: the catalog is the service's, not
ours, so a voice added after this release must still compile, and so must
a deprecated one an existing agent already names. It keeps the current
names visible at the call site without turning a stale SDK into a build
failure.

***

### CartesiaProvider

```ts
type CartesiaProvider = TtsProvider & {
  kind: typeof CARTESIA_KIND;
  options: CartesiaOptions & {
     voice: string;
  };
};
```

Descriptor returned by [cartesia](#cartesia).

#### Type Declaration

##### kind

```ts
readonly kind: typeof CARTESIA_KIND;
```

##### options

```ts
readonly options: CartesiaOptions & {
  voice: string;
};
```

###### Type Declaration

###### voice

```ts
voice: string;
```

***

### RimeProvider

```ts
type RimeProvider = TtsProvider & {
  kind: typeof RIME_KIND;
  options: RimeOptions & {
     voice: string;
  };
};
```

Descriptor returned by [rime](#rime).

#### Type Declaration

##### kind

```ts
readonly kind: typeof RIME_KIND;
```

##### options

```ts
readonly options: RimeOptions & {
  voice: string;
};
```

###### Type Declaration

###### voice

```ts
voice: string;
```

***

### TtsEvents

```ts
type TtsEvents = {
  audio: (pcm: Int16Array) => void;
  done: () => void;
  error: (err: TtsError) => void;
  words: (words: readonly TtsWordTiming[]) => void;
};
```

Events emitted by an open [TtsSession](#ttssession).

#### Properties

##### audio

```ts
audio: (pcm: Int16Array) => void;
```

One PCM16 audio chunk. Orchestrator forwards to the client.

###### Parameters

###### pcm

`Int16Array`

###### Returns

`void`

##### done

```ts
done: () => void;
```

Synthesis drained after flush() or cancel(). Emitted exactly once per
turn, and never after `cancel()` for the cancelled turn: `cancel()` must
clear any pending done timers/frames so a stale `done` cannot leak into
the next turn's flush-wait (the event carries no turn id, so the
pipeline transport cannot filter it — see pipeline-transport.ts).

###### Returns

`void`

##### error

```ts
error: (err: TtsError) => void;
```

Terminal error. The session is expected to end after this fires.

###### Parameters

###### err

[`TtsError`](#ttserror)

###### Returns

`void`

##### words

```ts
words: (words: readonly TtsWordTiming[]) => void;
```

Word timings for audio this turn has produced, when the provider reports
them. Required in the type but OPTIONAL in practice: every adapter builds
a `createNanoEvents<TtsEvents>()` emitter, so a provider with no timings
simply never emits it, and a consumer must treat their absence as the
ordinary case (the pipeline transport falls back to a proportional
estimate). Whether a given reply has timings is a RUNTIME fact — a
provider may report them for some segments and not others — so there is no
capability flag to check.

**Carries no turn id**, exactly like [TtsEvents.done](#done): the transport
cannot filter a stale one itself and gates the event on its own turn state
(the audio gate in `pipeline-transport.ts`). An adapter must not emit
timings for a cancelled turn.

###### Parameters

###### words

readonly [`TtsWordTiming`](#ttswordtiming)[]

###### Returns

`void`

***

### TtsProvider

```ts
type TtsProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  __stage?: "tts";
};
```

Descriptor for a TTS provider. Returned by factories like
`cartesia(...)` from `@alexkroman1/aai/tts`.

#### Type Declaration

##### \_\_stage?

```ts
readonly optional __stage?: "tts";
```

Compile-time stage tag; never present at runtime.

## Variables

### ASSEMBLYAI\_TTS\_API\_KEY\_ENV

```ts
const ASSEMBLYAI_TTS_API_KEY_ENV: "ASSEMBLYAI_API_KEY" = "ASSEMBLYAI_API_KEY";
```

Agent-env variable holding the AssemblyAI API key (same key as STT/LLM).

***

### ASSEMBLYAI\_TTS\_DEFAULT\_VOICE

```ts
const ASSEMBLYAI_TTS_DEFAULT_VOICE: "jane" = "jane";
```

Default voice when `assemblyAITts()` is called with no `voice` — a
US-accented English voice, since most agents face US callers (it was
`"vera"` for a while, which put a UK accent on every agent that never
chose). Pick from [ASSEMBLYAI\_TTS\_VOICES](#assemblyai_tts_voices) to change it; every voice
in the catalog speaks exactly one language, so changing `language`
generally means changing `voice` too.

***

### ASSEMBLYAI\_TTS\_DEPRECATED\_VOICES

```ts
const ASSEMBLYAI_TTS_DEPRECATED_VOICES: readonly ["arjun", "bella", "david", "diego", "dmitri", "eleanor", "emma", "giulia", "helen", "ivy", "james", "kyle", "luca", "lucia", "martha", "mateo", "pierre", "river", "tyler", "victor", "winter"];
```

Voices the service still accepts but has scheduled for removal.

Listed so that "is this name real?" and "should I use it?" stay separate
questions — an existing agent naming one of these is working today and
should not be told it is broken, while a new agent should not be pointed
at a voice that is going away.

***

### ASSEMBLYAI\_TTS\_KIND

```ts
const ASSEMBLYAI_TTS_KIND: "assemblyai";
```

Kind tag recognised by the host-side resolver.

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

### ASSEMBLYAI\_TTS\_VOICES

```ts
const ASSEMBLYAI_TTS_VOICES: {
  alba: {
     accent: "US";
     language: "en";
  };
  anna: {
     accent: "US";
     language: "en";
  };
  charles: {
     accent: "US";
     language: "en";
  };
  estelle: {
     accent: "FR";
     language: "fr";
  };
  eve: {
     accent: "US";
     language: "en";
  };
  george: {
     accent: "US";
     language: "en";
  };
  giovanni: {
     accent: "IT";
     language: "it";
  };
  jane: {
     accent: "US";
     language: "en";
  };
  jean: {
     accent: "US";
     language: "en";
  };
  juergen: {
     accent: "DE";
     language: "de";
  };
  lola: {
     accent: "ES";
     language: "es";
  };
  mary: {
     accent: "US";
     language: "en";
  };
  michael: {
     accent: "US";
     language: "en";
  };
  paul: {
     accent: "UK";
     language: "en";
  };
  rafael: {
     accent: "PT";
     language: "pt";
  };
  vera: {
     accent: "UK";
     language: "en";
  };
};
```

The voice catalog — voice id → the language it speaks and its accent.
The accent is descriptive metadata for choosing a voice, not a settable
option: [AssemblyAITtsOptions](#assemblyaittsoptions) has no `accent` field.

A constant rather than a sentence in a doc comment, because a wrong voice
id is a *silent* failure: it is a free-form string the service rejects
in-band after the socket opens, so the agent connects, reports ready, and
never speaks — the same shape as the unmapped-`language` bug below, and
nothing upstream of a live session catches it.

It is a constant for a second reason, learned the hard way. The list this
replaced lived in a doc comment and was simply wrong — it carried ten names
(`azelma`, `cosette`, `fantine`, `javert`, `marius`, `peter_yearsley` …)
that are in no published catalog, while omitting most of the real ones. A
list nobody can check drifts into fiction, and here the fiction is
indistinguishable, at authoring time, from a working agent.

Source: https://assemblyai.com/docs/voice-agents/voice-agent-api/voices

Anything that shows an author their choices — the scaffold guide, a picker
— should read this rather than restate it. A partial list is what sends
someone guessing, which is the failure being prevented.

#### Type Declaration

##### alba

```ts
readonly alba: {
  accent: "US";
  language: "en";
};
```

###### alba.accent

```ts
readonly accent: "US";
```

###### alba.language

```ts
readonly language: "en";
```

##### anna

```ts
readonly anna: {
  accent: "US";
  language: "en";
};
```

###### anna.accent

```ts
readonly accent: "US";
```

###### anna.language

```ts
readonly language: "en";
```

##### charles

```ts
readonly charles: {
  accent: "US";
  language: "en";
};
```

###### charles.accent

```ts
readonly accent: "US";
```

###### charles.language

```ts
readonly language: "en";
```

##### estelle

```ts
readonly estelle: {
  accent: "FR";
  language: "fr";
};
```

###### estelle.accent

```ts
readonly accent: "FR";
```

###### estelle.language

```ts
readonly language: "fr";
```

##### eve

```ts
readonly eve: {
  accent: "US";
  language: "en";
};
```

###### eve.accent

```ts
readonly accent: "US";
```

###### eve.language

```ts
readonly language: "en";
```

##### george

```ts
readonly george: {
  accent: "US";
  language: "en";
};
```

###### george.accent

```ts
readonly accent: "US";
```

###### george.language

```ts
readonly language: "en";
```

##### giovanni

```ts
readonly giovanni: {
  accent: "IT";
  language: "it";
};
```

###### giovanni.accent

```ts
readonly accent: "IT";
```

###### giovanni.language

```ts
readonly language: "it";
```

##### jane

```ts
readonly jane: {
  accent: "US";
  language: "en";
};
```

###### jane.accent

```ts
readonly accent: "US";
```

###### jane.language

```ts
readonly language: "en";
```

##### jean

```ts
readonly jean: {
  accent: "US";
  language: "en";
};
```

###### jean.accent

```ts
readonly accent: "US";
```

###### jean.language

```ts
readonly language: "en";
```

##### juergen

```ts
readonly juergen: {
  accent: "DE";
  language: "de";
};
```

###### juergen.accent

```ts
readonly accent: "DE";
```

###### juergen.language

```ts
readonly language: "de";
```

##### lola

```ts
readonly lola: {
  accent: "ES";
  language: "es";
};
```

###### lola.accent

```ts
readonly accent: "ES";
```

###### lola.language

```ts
readonly language: "es";
```

##### mary

```ts
readonly mary: {
  accent: "US";
  language: "en";
};
```

###### mary.accent

```ts
readonly accent: "US";
```

###### mary.language

```ts
readonly language: "en";
```

##### michael

```ts
readonly michael: {
  accent: "US";
  language: "en";
};
```

###### michael.accent

```ts
readonly accent: "US";
```

###### michael.language

```ts
readonly language: "en";
```

##### paul

```ts
readonly paul: {
  accent: "UK";
  language: "en";
};
```

###### paul.accent

```ts
readonly accent: "UK";
```

###### paul.language

```ts
readonly language: "en";
```

##### rafael

```ts
readonly rafael: {
  accent: "PT";
  language: "pt";
};
```

###### rafael.accent

```ts
readonly accent: "PT";
```

###### rafael.language

```ts
readonly language: "pt";
```

##### vera

```ts
readonly vera: {
  accent: "UK";
  language: "en";
};
```

###### vera.accent

```ts
readonly accent: "UK";
```

###### vera.language

```ts
readonly language: "en";
```

***

### CARTESIA\_API\_KEY\_ENV

```ts
const CARTESIA_API_KEY_ENV: "CARTESIA_API_KEY" = "CARTESIA_API_KEY";
```

Agent-env variable holding the Cartesia API key.

***

### CARTESIA\_DEFAULT\_VOICE

```ts
const CARTESIA_DEFAULT_VOICE: "f786b574-daa5-4673-aa0c-cbe3e8534c02" = "f786b574-daa5-4673-aa0c-cbe3e8534c02";
```

Default voice used when callers invoke `cartesia()` with no `voice`. This
is the same voice the example templates ship with, so a bare `cartesia()`
works out of the box for new agents.

***

### CARTESIA\_KIND

```ts
const CARTESIA_KIND: "cartesia";
```

Kind tag recognised by the host-side resolver.

***

### RIME\_API\_KEY\_ENV

```ts
const RIME_API_KEY_ENV: "RIME_API_KEY" = "RIME_API_KEY";
```

Agent-env variable holding the Rime API key.

***

### RIME\_DEFAULT\_VOICE

```ts
const RIME_DEFAULT_VOICE: "cove" = "cove";
```

Default Rime speaker used when callers invoke `rime()` with no `voice`.
`cove` is a `mistv2` speaker, matching the default model below — so a
bare `rime()` works out of the box for new agents.

***

### RIME\_KIND

```ts
const RIME_KIND: "rime";
```

Kind tag recognised by the host-side resolver.

## Functions

### assemblyAITts()

```ts
function assemblyAITts(opts?: AssemblyAITtsOptions): AssemblyAITtsProvider;
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

[`AssemblyAITtsProvider`](#assemblyaittsprovider)

***

### cartesia()

```ts
function cartesia(opts?: CartesiaOptions): CartesiaProvider;
```

Build a Cartesia TTS descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`CARTESIA_API_KEY`).

#### Parameters

##### opts?

[`CartesiaOptions`](#cartesiaoptions)

#### Returns

[`CartesiaProvider`](#cartesiaprovider)

***

### rime()

```ts
function rime(opts?: RimeOptions): RimeProvider;
```

Build a Rime TTS descriptor for pipeline mode. The API key is resolved
host-side from the agent's env (`RIME_API_KEY`).

#### Parameters

##### opts?

[`RimeOptions`](#rimeoptions)

#### Returns

[`RimeProvider`](#rimeprovider)

## References

### Unsubscribe

Re-exports [Unsubscribe](stt.md#unsubscribe)
