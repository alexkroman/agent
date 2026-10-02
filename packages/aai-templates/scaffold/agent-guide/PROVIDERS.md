# Providers — STT, LLM and TTS

Part of the aai authoring guide (start with the core guide). Declare only the
stages you are changing; every unset stage runs on the AssemblyAI default.
Choosing between pipeline and S2S is `PIPELINE-TUNING.md`.

## Providers

Provider SDKs are **optional peer dependencies**. Install only the SDKs for the
providers you actually use.

### STT — `@alexkroman1/aai/stt`

| Factory         | Default model          | Env var              |
| --------------- | ---------------------- | -------------------- |
| `assemblyAIStt` | `"universal-3-5-pro"`  | `ASSEMBLYAI_API_KEY` |
| `deepgramStt`   | `"nova-3"`             | `DEEPGRAM_API_KEY`   |
| `elevenLabsStt` | `"scribe_v2_realtime"` | `ELEVENLABS_API_KEY` |
| `sonioxStt`     | `"stt-rt-v3"`          | `SONIOX_API_KEY`     |

All STT factories accept `{ model?: string, ... }`. Bare calls (`deepgramStt()`,
`sonioxStt()`, etc.) use the default model. Language is spelled `language` where
the vendor takes one code (`deepgramStt`, `elevenLabsStt`) and `languages` where
it takes a list (`assemblyAIStt`, `sonioxStt`) — and only `deepgramStt`'s unset
value means English; the other three auto-detect.

`elevenLabsStt` carries the stage in its name because ElevenLabs is better known
for TTS: when that stage arrives, `elevenLabs` is the name it should get.

`assemblyAIStt` accepts an optional `region: "eu"` for EU data residency — it
routes streaming transcription to AssemblyAI's EU endpoints. EU-region API keys
require it; the US endpoints reject them. Example:
`assemblyAIStt({ model: "universal-3-5-pro", region: "eu" })`.

### LLM — `@alexkroman1/aai/llm`

ONE factory, `llm({ provider, model, baseUrl?, apiKeyEnv?, providerOptions? })`.
The provider is a string, not a function name:

| `provider`     | SDK package         | Env var                        |
| -------------- | ------------------- | ------------------------------ |
| `"anthropic"`  | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY`            |
| `"openai"`     | `@ai-sdk/openai`    | `OPENAI_API_KEY`               |
| `"google"`     | `@ai-sdk/google`    | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `"mistral"`    | `@ai-sdk/mistral`   | `MISTRAL_API_KEY`              |
| `"xai"`        | `@ai-sdk/xai`       | `XAI_API_KEY`                  |
| `"groq"`       | `@ai-sdk/groq`      | `GROQ_API_KEY`                 |
| `"cerebras"`   | `@ai-sdk/openai`    | `CEREBRAS_API_KEY`             |
| `"openrouter"` | `@ai-sdk/openai`    | `OPENROUTER_API_KEY`           |
| `"gateway"`    | `ai` (built in)     | `AI_GATEWAY_API_KEY`           |
| `"assemblyai"` | `@ai-sdk/openai`    | `ASSEMBLYAI_API_KEY`           |

`model` is required. Example:
`llm({ provider: "anthropic", model: "claude-haiku-4-5" })`. `"openrouter"` and
`"gateway"` (the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway))
address a model as `"creator/model"`; every other provider takes its own bare
id.

`provider` is OPEN: any other string compiles. A provider with no built-in entry
is reached as an OpenAI-compatible endpoint by naming its `baseUrl` (and
`apiKeyEnv`, the variable its key is in); `aai build` warns about an unknown
provider that has neither. `providerOptions` carries provider-specific settings:
a native client's AI SDK `providerOptions`; on `openrouter`, `cerebras` or a
`baseUrl` provider, raw request-body fields (`top_k`).

`"assemblyai"` routes through the
[AssemblyAI LLM Gateway](https://www.assemblyai.com/docs/llm-gateway) — an
OpenAI-compatible endpoint fronting 25+ models (Claude, GPT, Gemini, etc.) with
the same API key as AssemblyAI STT. A bare model-id string on `llm` is shorthand
for it (and a `"creator/model"` string for `"gateway"`), and unset stages keep
the AssemblyAI default:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  llm: "claude-sonnet-4-6",
});
```

`llm({ provider: "assemblyai", model, providerOptions: { region: "eu" } })` is
the explicit form; `region` selects EU data residency, and `reasoningEffort`
beside it sets the model's reasoning effort.

Mixing providers works the same way — declare the stages you're changing:

```ts
import { agent } from "@alexkroman1/aai";
import { cartesiaTts } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  llm: "claude-sonnet-4-6",
  tts: cartesiaTts(),
});
```

### TTS — `@alexkroman1/aai/tts`

| Factory         | Default voice                            | Env var              |
| --------------- | ---------------------------------------- | -------------------- |
| `assemblyAITts` | `"jane"`                                 | `ASSEMBLYAI_API_KEY` |
| `cartesiaTts`   | `"f786b574-daa5-4673-aa0c-cbe3e8534c02"` | `CARTESIA_API_KEY`   |
| `rimeTts`       | `"cove"` (model `mistv2`)                | `RIME_API_KEY`       |

Bare calls (`assemblyAITts()`, `cartesiaTts()`, `rimeTts()`) use the defaults.
Override with `{ voice, model, language }`.

**AssemblyAI TTS** shares `ASSEMBLYAI_API_KEY` with AssemblyAI STT and the LLM
Gateway, so an all-AssemblyAI pipeline needs exactly one secret. On the default
pipeline, `tts: assemblyAITts({ voice: "michael" })` changes the voice and
leaves the other two stages on the default. Each voice speaks one language, and
this is the whole catalog — **a voice not on this list is rejected after the
socket opens, which leaves the agent connected, "ready", and permanently
silent**, so pick one from here rather than guessing a plausible name:

- **English, US accent**: `alba`, `anna`, `charles`, `eve`, `george`, `jane`
  (the default), `jean`, `mary`, `michael`
- **English, UK accent**: `paul`, `vera`
- **Native accent, code-switches with English**: `estelle` (fr), `giovanni`
  (it), `juergen` (de), `lola` (es), `rafael` (pt)

There is no separate age/gender/style axis — match the persona by picking a name
and accent, and put the delivery in the system prompt instead.

Set `language` only alongside a voice that speaks it, as an ISO 639-1 code —
`"en"`, `"fr"`, `"de"`, `"it"`, `"pt"`, `"es"` are the six the catalog covers,
and the SDK translates each to the full name the service wants. An unsupported
code, and a code the declared voice does not speak, are both build errors naming
the voices that do speak it — including the one you get by setting `language`
alone, since the descriptor then fills in the default English voice. (A voice
this release's catalog does not list is passed through: the catalog is the
service's, so a voice it ships later still works.)

**Rime quirk:** language uses ISO 639-3 three-letter codes (e.g. `"eng"` not
`"en"`).

Set provider keys the same way as any secret: `.env` for local dev,
`aai secret put` for production.
