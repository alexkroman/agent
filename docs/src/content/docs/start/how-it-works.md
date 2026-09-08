---
title: How it works
description: The project layout, and the one idea behind it.
---

An agent is a directory. Everything in it is discovered by where it sits, not
by a registration call somewhere else.

```text
my-agent/
  agent.ts            # the definition — required
  system-prompt.md    # the system prompt — discovered, not imported
  tools/              # one file per tool; filename IS the tool name
    get_weather.ts
  workflows/          # long-running jobs (optional)
  client.tsx          # your own browser UI (optional, React)
  shared.ts           # types and state shared by both of those
  agent.test.ts       # ordinary vitest — `aai test`
  .env                # local secrets; `aai publish` syncs them
```

That is the whole idea: **a file in `tools/` is a tool because it is in
`tools/`.** There is no `tools` array to keep in sync, no import list to
forget, and adding an ability is adding a file.

## What runs where

Your code runs on a server, not in the browser. The browser (or a phone
carrier) sends audio; the runtime does the rest:

1. **Listen.** Speech-to-text turns the caller's audio into words, and decides
   when they have finished a thought.
2. **Think.** The model gets the conversation so far and your system prompt. If
   it wants a tool, the runtime runs your `execute` function and hands back the
   result.
3. **Speak.** Text-to-speech turns the reply into audio, paced out to the
   caller as it is generated.

You can swap any of the three, or replace all of them with a single
speech-to-speech socket. See [Voices and models](/agent/more/voices-and-models/).

## What you don't have to build

A spoken conversation has failure modes that a chat UI doesn't, and the
runtime handles them with measured defaults so that a first agent behaves
reasonably before you have tuned anything:

- A cough or an "mm-hm" doesn't cut the agent off mid-sentence.
- If room noise does trip an interruption and no real turn follows, the reply
  picks up where the caller stopped hearing it.
- A slow tool doesn't leave the caller in silence — the agent says something
  short while it waits.
- An interrupted reply is recorded as the words the caller actually *heard*,
  so the model doesn't think it already told them something it didn't.
- A provider blip is spoken aloud rather than becoming a dead line.

Each of those is a field on `agent()` when you disagree with the default. They
are listed in the [SDK reference](/agent/reference/) — you don't need any of
them to start.

## The two front doors

Most of these docs are about `agent()` — a live conversation with a
microphone on the other end.

There is a second one. When the audio arrives as a *file* and the job takes
minutes rather than seconds — transcribe this recording, redact this call,
summarize this archive — you declare a `workflowApp()` instead and get an
ordinary web page over the same runtime, with no session and no model loop.
See [Background jobs](/agent/more/background-jobs/).
