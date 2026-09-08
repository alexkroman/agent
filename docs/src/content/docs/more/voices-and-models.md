---
title: Voices and models
description: Swap one stage or all three. Unset stages keep the default.
---

By default an agent listens, thinks, and speaks through AssemblyAI, billed to
the one key in your `.env`. Each stage is a field, and **anything you leave
unset stays on the default** — so swapping one thing is one line.

## A voice

```ts
import { agent } from "@alexkroman1/aai";

export default agent({ name: "My Agent", voice: "michael" });
```

## A model

`llm` takes a bare model id:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({ name: "My Agent", llm: "claude-sonnet-4-6" });
```

A bare id routes through the AssemblyAI LLM gateway on your existing key. A
`"creator/model"` id routes through the Vercel AI Gateway and needs
`AI_GATEWAY_API_KEY` in your secrets.

## A whole stage

Import a factory from the stage's subpath and pass the descriptor:

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

| Subpath | Factories |
| --- | --- |
| `@alexkroman1/aai/stt` | `assemblyAIStt`, `deepgramStt`, `elevenLabsStt`, `sonioxStt` |
| `@alexkroman1/aai/llm` | `assemblyAILlm`, `anthropicLlm`, `openAILlm`, `googleLlm`, `mistralLlm`, `xAILlm`, `groqLlm`, `openRouterLlm`, `gatewayLlm` |
| `@alexkroman1/aai/tts` | `assemblyAITts`, `cartesiaTts`, `rimeTts` |

These factories return plain descriptors — serializable data, not SDK clients.
No provider SDK and no secret ever enters your bundle; credentials resolve
server-side from the agent's own environment. Each factory's options are in the
[SDK reference](/agent/reference/).

## Speech-to-speech

One socket instead of three stages — the transcription, the model loop, and the
voice all run service-side. It is an explicit opt-in, never something you reach
by omission:

```ts
import { agent } from "@alexkroman1/aai";
import { openAIS2s } from "@alexkroman1/aai/s2s";

export default agent({ name: "My Agent", s2s: openAIS2s() });
```

Build the cascaded pipeline unless you specifically want this. The pipeline is
where the interruption handling, the endpointing knobs, and the resume
behaviour live, because those are decisions a service-side loop makes for you.

## Tuning the conversation

The runtime's defaults for interruption, endpointing, dead air, and silence are
measured, and each is a field on `agent()` when you disagree. They are listed
in the [SDK reference](/agent/reference/) — reach for them when you have heard
a specific problem, not before.
