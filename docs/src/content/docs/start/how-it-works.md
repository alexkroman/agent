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
  workflows/          # long-running jobs (optional); registered by name
  client.tsx          # your own browser UI (optional, React)
  shared.ts           # types and state shared by both of those
  agent.test.ts       # ordinary vitest — `aai test`
  agent.eval.test.ts  # does it BEHAVE — `aai eval`
  .env                # local secrets; `aai publish` syncs them
```

That is the whole idea: **a file in `tools/` is a tool because it is in
`tools/`.** There is no `tools` array to keep in sync and no import list to
forget. Adding an ability is adding a file, and `system-prompt.md` and
`client.tsx` work the same way.

`workflows/` is the one exception — you name those yourself. See
"Agents and background jobs" below.

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

Voice conversations go wrong in ways a chat UI never does. The runtime
already handles these, so your first agent behaves sensibly with no tuning:

- A cough or an "mm-hm" doesn't cut the agent off mid-sentence.
- If room noise does trip an interruption and no real turn follows, the reply
  picks up where the caller stopped hearing it.
- A slow tool doesn't leave the caller in silence — the agent says something
  short while it waits.
- If the agent is cut off mid-sentence, the conversation history records only
  what the caller actually heard.
- A provider blip is spoken aloud rather than becoming a dead line.

You need none of them to start. Four are fields on `agent()` for when you
disagree with the default, listed in the [SDK reference](/agent/reference/).
The history truncation is not tunable.

## Agents and background jobs

Most of these docs are about `agent()`: a live conversation with a microphone
on the other end.

There is a second kind. When the audio is a file and the job takes minutes —
transcribe this recording, summarize this archive — you declare a
`workflowApp()` instead and get a web page instead of a conversation.

That is what `workflows/` holds: a workflow's modules, its body and the steps
it calls, rather than one file per workflow. You register each workflow by name
on `agent()`, which is the one place a name is yours to choose rather than
taken from a filename.

:::note[Why a workflow isn't named after its file]
A workflow's name is stored with every run of it. If renaming a file renamed
the workflow, the next deploy would abandon the jobs still in flight under the
old name.
:::

See [Background jobs](/agent/more/background-jobs/) for both.

## Next

- [Your agent](/agent/build/agent/) — the fields and the system prompt
- [Tools](/agent/build/tools/) — giving it something to do
