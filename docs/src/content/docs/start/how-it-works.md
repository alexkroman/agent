---
title: How it works
description: The project layout, and the one idea behind it.
---

An agent is a directory. Each file does its job because of where it sits, not
because something registers it.

```text
my-agent/
  agent.ts            # the definition — required
  system-prompt.md    # what the model is told
  tools/              # one file per tool; the filename is the tool's name
    get_weather.ts
  workflows/          # long-running jobs (optional)
  client.tsx          # your own browser UI (optional, React)
  shared.ts           # code used by more than one of the above
  agent.test.ts       # tests — `aai test`
  agent.eval.test.ts  # behaviour checks — `aai eval`
  .env                # local secrets; `aai publish` copies them up
```

`aai init` writes five of these — `agent.ts`, `system-prompt.md`, one tool, and
the two test files — plus the usual `package.json`, `tsconfig.json`, and `.env`.
You add `workflows/`, `client.tsx`, and `shared.ts` when you need them. Each
starts working the moment it exists.

That is the whole idea: **a file in `tools/` is a tool because it is in
`tools/`.** There is no list to keep in sync and no import to forget. Adding an
ability is adding a file, and `system-prompt.md` and `client.tsx` work the same
way.

## What runs where

Your code runs on a server, not in the browser. The browser — or a phone
carrier — sends audio, and the runtime does the rest:

1. **Listen.** Speech-to-text turns the caller's audio into words, and works
   out when they have finished a thought.
2. **Think.** The model gets the conversation so far and your system prompt. If
   it asks for a tool, the runtime runs your `execute` function and hands back
   the result.
3. **Speak.** Text-to-speech turns the reply into audio and plays it to the
   caller as it is generated.

You can swap any of the three. See
[Voices and models](/agent/more/voices-and-models/).

## What you don't have to build

Voice conversations go wrong in ways a chat window never does. The runtime
already handles these, so your first agent behaves sensibly with no tuning:

- A cough or an "mm-hm" doesn't cut the agent off mid-sentence.
- If noise does interrupt it and no one speaks, the reply picks up where the
  caller stopped hearing it.
- A slow tool doesn't leave the caller in silence — the agent says something
  short while it waits.
- If the agent is cut off, the conversation history keeps only what the caller
  actually heard.
- A provider hiccup is spoken aloud instead of becoming a dead line.

You need none of them to start. Most have a field on `agent()` for when you
disagree with the default; the [SDK reference](/agent/reference/) lists them.
Trimming the history is the one that is always on.

## Agents and background jobs

Most of these docs are about `agent()` — a live conversation with a microphone
on the other end.

There is a second kind. When the audio is a file and the job takes minutes —
transcribe this recording, summarize this archive — you write a `workflowApp()`
instead, and get a web page instead of a conversation. That is what
`workflows/` holds. A workflow is the one thing you name yourself rather than
taking the name from a filename.

See [Background jobs](/agent/more/background-jobs/) for both.

## Next

- [Your agent](/agent/build/agent/) — the fields and the system prompt
- [Tools](/agent/build/tools/) — giving it something to do
