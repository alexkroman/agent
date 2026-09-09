---
title: Voices and models
description: Swap one stage or all three. Unset stages keep the default.
---

By default an agent listens, thinks, and speaks through AssemblyAI, billed to
the one key in your `.env`.

Each stage is a field, and **anything you leave unset stays on the default** —
so swapping one thing is one line.

## A voice

```ts
import { agent } from "@alexkroman1/aai";

export default agent({ name: "My Agent", voice: "michael" });
```

Ids come from `ASSEMBLYAI_TTS_VOICES` (`@alexkroman1/aai/tts`). Every voice
speaks exactly one language.

The type is autocomplete rather than a guard: the catalog belongs to the
service, so a voice added after your SDK release still has to work.

:::caution[A misspelled voice id is refused after the socket opens]
That leaves an agent that connects, reports ready, and never speaks. So
`aai build` and `aai dev` warn about an id they do not recognise, and name the
ones it is closest to.
:::

## A model

`llm` takes a bare model id:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({ name: "My Agent", llm: "claude-sonnet-4-6" });
```

A bare id routes through the AssemblyAI LLM gateway on your existing key. A
`"creator/model"` id routes through the Vercel AI Gateway and needs
`AI_GATEWAY_API_KEY` in your secrets.

Bare ids autocomplete from `AssemblyAIGatewayModel` (`@alexkroman1/aai`), the
union generated from what the gateway advertises. Like `voice`, it is
autocomplete rather than a guard — a model shipped after your SDK release still
works — so an id the gateway does not carry is a 400 on the first turn rather
than a build error.

## A whole stage

Import the provider you want and pass it to the matching field:

```ts
import { agent } from "@alexkroman1/aai";
import { deepgramStt } from "@alexkroman1/aai/stt";
import { cartesiaTts } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  stt: deepgramStt(),
  tts: cartesiaTts({ voice: "…" }),
  // `llm` unset → still AssemblyAI
});
```

| Factory | Import from | Key it reads |
| --- | --- | --- |
| `assemblyAIStt`, `assemblyAITts`, `assemblyAILlm` | `/stt`, `/tts`, `/llm` | `ASSEMBLYAI_API_KEY` |
| `deepgramStt` | `@alexkroman1/aai/stt` | `DEEPGRAM_API_KEY` |
| `elevenLabsStt` | `@alexkroman1/aai/stt` | `ELEVENLABS_API_KEY` |
| `sonioxStt` | `@alexkroman1/aai/stt` | `SONIOX_API_KEY` |
| `cartesiaTts` | `@alexkroman1/aai/tts` | `CARTESIA_API_KEY` |
| `rimeTts` | `@alexkroman1/aai/tts` | `RIME_API_KEY` |
| `anthropicLlm` | `@alexkroman1/aai/llm` | `ANTHROPIC_API_KEY` |
| `openAILlm` | `@alexkroman1/aai/llm` | `OPENAI_API_KEY` |
| `googleLlm` | `@alexkroman1/aai/llm` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `mistralLlm` | `@alexkroman1/aai/llm` | `MISTRAL_API_KEY` |
| `xAILlm` | `@alexkroman1/aai/llm` | `XAI_API_KEY` |
| `groqLlm` | `@alexkroman1/aai/llm` | `GROQ_API_KEY` |
| `openRouterLlm` | `@alexkroman1/aai/llm` | `OPENROUTER_API_KEY` |
| `gatewayLlm` | `@alexkroman1/aai/llm` | `AI_GATEWAY_API_KEY` |

Put that key in `.env` locally, and in your agent's secrets in production — see
[Publish](/agent/deploy/publish/). It is read on the server and never reaches
the browser. Each factory's options are in the
[SDK reference](/agent/reference/).

## Speech-to-speech

One socket instead of three stages: the transcription, the model loop, and the
voice all run service-side. It is an explicit opt-in, never something you reach
by omission:

```ts
import { agent } from "@alexkroman1/aai";
import { openAIS2s } from "@alexkroman1/aai/s2s";

export default agent({ name: "My Agent", s2s: openAIS2s() });
```

Prefer the three-stage default unless you specifically want this. It gives you
more control over how interruptions and pauses are handled.

## Tuning the conversation

How the agent handles interruptions, pauses, and silence is tuned by fields on
`agent()`. They are in the [SDK reference](/agent/reference/) — reach for them
once you have heard a specific problem, not before.
