---
title: Voices and models
description: Swap one stage or all three. Unset stages keep the default.
---

An agent hears, thinks and speaks in three stages: speech-to-text (**STT**), a
language model (**LLM**), and text-to-speech (**TTS**). All three are AssemblyAI
by default, billed to the one key in your `.env`. Come here when you want a
different voice, a different model, or a different provider for any stage.

Each stage is a field on `agent()`, and anything you leave unset stays on the
default — so swapping one thing is one line.

## A voice

```ts
import { agent } from "@alexkroman1/aai";

export default agent({ name: "My Agent", voice: "michael" });
```

The ids are the keys of `ASSEMBLYAI_TTS_VOICES` (`@alexkroman1/aai/tts`). Every
voice speaks exactly one language, so changing the language usually means
changing the voice too.

The type autocompletes but does not guard. The catalog belongs to the service,
so a voice added after your SDK release still has to work.

:::caution[A misspelled voice id is refused after the socket opens]
That leaves an agent that connects, reports ready, and never speaks. So
`aai build` and `aai dev` warn about an id they do not recognize, and name the
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
autocomplete rather than a guard.

:::caution[A wrong model id is a gateway error on the first turn]
Nothing catches it at build time the way a voice id is caught. An id the gateway
does not carry comes back as a 400 the first time the agent tries to think, so
the session opens and then fails on the caller's first sentence.
:::

## A whole stage

Import the provider you want and pass it to the matching field:

```ts
import { agent } from "@alexkroman1/aai";
import { deepgramStt } from "@alexkroman1/aai/stt";
import { cartesiaTts } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  stt: deepgramStt(),
  tts: cartesiaTts(),
  // `llm` unset → still AssemblyAI
});
```

Each factory reads one key from the environment:

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

Speech-to-speech (**S2S**) replaces all three stages with one socket: the
transcription, the model loop and the voice all run inside a single service. It
is an explicit opt-in, never something you reach by omission.

```ts
import { agent } from "@alexkroman1/aai";
import { openAIS2s } from "@alexkroman1/aai/s2s";

export default agent({ name: "My Agent", s2s: openAIS2s() });
```

`assemblyAIS2s()` is the other one, from the same subpath.

What you buy is one round trip instead of three hops. What you give up is the
seams. Providers can no longer be mixed, the S2S descriptor owns its own voice
rather than the `voice` field, and the tuning fields below are implemented by
the three-stage pipeline alone — so setting one on an S2S agent is a compile
error naming the rule rather than a silent no-op.

Stay on the three-stage default unless response time is the specific problem you
are trying to fix.

## Tuning the conversation

Four fields on `agent()` decide how a pipeline agent handles pauses and
interruptions. Reach for them once you have heard a specific problem, not
before.

| Field | What it decides | Default |
| --- | --- | --- |
| `maxTurnSilenceMs` | How long a caller may pause mid-sentence before the turn is force-ended. Raise it for callers who dictate addresses or confirmation numbers. | `3000` |
| `minBargeInWords` | How many words of caller speech interrupt the agent's reply. `1` interrupts on any word; the default lets "yeah" and "mm-hmm" through. | `2` |
| `interruptionMinDurationMs` | How long that speech must be sustained before it counts as an interruption. `0` disables the gate. | `500` |
| `deadAirCoverMs` | How long a turn may send nothing before the agent speaks a short filler, so a long tool chain does not sound like a dropped call. `0` disables. | `5000` |

The rest, including the phrases spoken on a provider failure, are in the
[SDK reference](/agent/reference/).

## Next

- [Your agent](/agent/build/agent/) — the other fields on `agent()`
- [Publish](/agent/deploy/publish/) — where a provider key goes in production
