---
title: Your agent
description: The agent.ts file, the system prompt, and the handful of fields worth knowing on day one.
---

`agent.ts` exports one call. The only required field is a name:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
});
```

That already runs. It uses the default AssemblyAI pipeline for listening,
thinking, and speaking, all billed to the one key in your `.env`.

## The fields you'll actually set

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Support Line",
  greeting: "Support line — what can I help with?",
  voice: "michael",
});
```

| Field | What it does |
| --- | --- |
| `name` | Display name. Required. |
| `greeting` | The first thing the agent says. |
| `voice` | Which voice speaks, e.g. `"michael"`, `"paul"`. |
| `llm` | A model id, e.g. `"claude-sonnet-4-6"`. Defaults to AssemblyAI's. |
| `requiredEnv` | Keys your tools read. Checked at publish, not mid-call. |

Everything else — provider swaps, interruption tuning, endpointing, step
limits — is documented in the [SDK reference](/agent/reference/). You do not
need any of it to build something good.

## The system prompt is a file

Write it in `system-prompt.md`, beside `agent.ts`. Nothing imports it and no
field points at it — the build finds it because it is there:

```md
You are a concise, friendly assistant.

- Keep replies to one or two sentences.
- Never read a URL aloud.
```

It is a file rather than a string because a prompt is a *document*. Inline, it
becomes `\n\n` and `\n-` escapes inside one string literal, with no wrapping,
no preview, and a one-line diff no matter which bullet changed. Editing the
prompt is the main loop of building an agent, so it belongs somewhere you can
read it.

Three things are errors rather than surprises:

- `system-prompt.md` exists *and* `agent.ts` declares a different
  `systemPrompt` → the build fails. "I edited the prompt and nothing changed"
  is the failure this prevents.
- An empty `system-prompt.md` → an error, not a silent fall-through.
- A `system-prompt/` directory → rejected. One file, no ordering to guess.

Declare neither and you get `DEFAULT_SYSTEM_PROMPT`, which is exported so you
can read what you are replacing:

```ts
import { DEFAULT_SYSTEM_PROMPT, agent } from "@alexkroman1/aai";

export default agent({
  name: "Pizza Line",
  systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\nYou only ever discuss pizza.`,
});
```

That is also the one case where you write the import: when part of the prompt
is computed — a menu, a catalogue, today's date — import the file and build the
field.

## Writing for a voice

A prompt that reads well on a screen often sounds terrible out loud. Two rules
carry most of the difference:

- **Ask for one or two sentences.** A model's default paragraph is thirty
  seconds of talking, and the caller cannot skim it.
- **Say what not to read aloud.** URLs, ids, and long numbers are the usual
  offenders.

## Next

- [Tools](/agent/build/tools/) — let it do things
- [Remembering things](/agent/build/state/) — state across a conversation
- [Voices and models](/agent/more/voices-and-models/) — swapping any stage
