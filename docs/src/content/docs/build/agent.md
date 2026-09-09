---
title: Your agent
description: The agent.ts file, the fields worth setting first, and how the system prompt works.
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
| `name` | Display name — the only required field |
| `greeting` | The first thing the agent says |
| `voice` | Which voice speaks, e.g. `"michael"`, `"paul"` |
| `llm` | A model id, e.g. `"claude-sonnet-4-6"`; defaults to AssemblyAI's |
| `requiredEnv` | Keys your tools read — a missing one is warned about at deploy |

Every other field is in the [SDK reference](/agent/reference/). You do not
need any of them to build something good.

### About `voice` and `llm`

Both autocomplete the ids this SDK release knows about, and neither is checked
by the compiler — so a wrong id fails when the session opens rather than when
you build. See
[Voices and models](/agent/more/voices-and-models/) for what each one accepts
and how a wrong one shows up.

## The system prompt is a file

Write it in `system-prompt.md`, beside `agent.ts`. Nothing imports it and no
field points at it — the build finds it because it is there:

```md
<!-- system-prompt.md -->
You are a concise, friendly assistant.

- Keep replies to one or two sentences.
- Never read a URL aloud.
```

Editing this file is most of building an agent, so it gets to be a real
markdown file you can read.

Write the prompt in one place. If `system-prompt.md` exists and `agent.ts`
also sets `systemPrompt`, the build stops and tells you, rather than letting
you edit a file that is being ignored.

## Your prompt is added to the framework's, not swapped in for it

**Write only your own domain rules.** `"You only ever discuss pizza."` is a
complete system prompt.

Whatever you write — in `system-prompt.md` or in `systemPrompt` — is appended
to the voice rules the framework always sends: how to speak a number, how to
read a transcript, one question per turn, today's date. Your rules come last,
under a header saying they win where the two conflict.

:::caution[Never interpolate `DEFAULT_SYSTEM_PROMPT` into your prompt]
That sends the ~10,000-character voice core twice, once by the framework and
once by you, under two precedence headers arguing with each other — and you pay
for it on every turn. A leading copy is dropped automatically and a warning is
printed. A copy anywhere else is warned about and sent.
:::

The constant is exported to be READ, not composed. Print it while tuning, or
diff it across SDK versions:

```ts
import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";

console.log(DEFAULT_SYSTEM_PROMPT); // what your rules are added to
```

When part of your prompt is computed — a menu, a catalog — build that string
and pass it as `systemPrompt`. It is still only your own rules. Today's date is
already in every prompt, so that is not one of the reasons to compute one.

## A prompt that changes during the call

Pass a function instead of a string and it is called as each model request is
assembled, with the live session, so what the agent is told can move with the
conversation:

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";

const cart = sessionSlot("cart", (): { items: string[] } => ({ items: [] }));

export default agent({
  name: "Intake",
  systemPrompt: (ctx) =>
    `Take the caller's order.\n\nIn the cart: ${cart.get(ctx).items.join(", ") || "nothing yet"}`,
});
```

What it is handed is the session: its id, the agent's `env`, and its slots — so
the prompt can say what no tool result told the model. Everything above still
applies: what it returns is added to the framework's own rules, not swapped in
for them. Two things it owes — it must return a string, and it must be
synchronous, because the request is being assembled and there is nowhere to
await that does not put a round trip in front of every turn.

It is never called at build time, so nothing it reads has to exist before a
session does. `aai build` reports the prompt as "a per-request resolver" rather
than a value.

Most agents want a string. Reach for this when the model has to know something
mid-call that no tool result tells it.

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
