# s2s

`@alexkroman1/aai/s2s` subpath barrel.

Re-exports S2S descriptor factories. Importing this barrel does not
pull in any provider SDK — the host resolver handles that at session
start.

Named re-exports rather than `export *`: the wildcard form needs a
`noReExportAll` suppression per line, and the escape-hatch ratchet only
moves down. Listing them also makes the public surface of this subpath
readable in one place — add new symbols here when a provider gains one.

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

### OPENAI\_REALTIME\_API\_KEY\_ENV

```ts
const OPENAI_REALTIME_API_KEY_ENV: "OPENAI_API_KEY" = "OPENAI_API_KEY";
```

Env var holding this stage's credential — the same string as the OpenAI LLM
constant, under a name of its own so `apiKeyEnv` can repoint this stage
alone (see `descriptorEnvVar` in `host/providers/resolve.ts`).

***

### OPENAI\_REALTIME\_KIND

```ts
const OPENAI_REALTIME_KIND: "openai-realtime";
```

Kind tag recognised by the host-side resolver.

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

## References

### ASSEMBLYAI\_S2S\_API\_KEY\_ENV

Re-exports [ASSEMBLYAI_S2S_API_KEY_ENV](index.md#assemblyai_s2s_api_key_env)

***

### ASSEMBLYAI\_S2S\_KIND

Re-exports [ASSEMBLYAI_S2S_KIND](index.md#assemblyai_s2s_kind)

***

### assemblyAIS2s

Re-exports [assemblyAIS2s](index.md#assemblyais2s)

***

### AssemblyAIS2sOptions

Re-exports [AssemblyAIS2sOptions](index.md#assemblyais2soptions)

***

### AssemblyAIS2sProvider

Re-exports [AssemblyAIS2sProvider](index.md#assemblyais2sprovider)
