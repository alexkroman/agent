---
title: Quickstart
description: Build, run, and publish a working voice agent in about five minutes.
---

You need Node.js 24, 25, or 26 and an AssemblyAI API key. That one key covers
listening, thinking, and speaking — get one from the
[AssemblyAI dashboard](https://www.assemblyai.com/dashboard) if you don't have
one already.

## 1. Create a project

```sh
npm i -g @alexkroman1/aai-cli
aai init my-agent
cd my-agent
```

`aai init` scaffolds a project from a template and installs its dependencies
with whichever package manager you ran it from.

:::caution[Fill in your API key first]
The scaffold writes a `.env` with an empty `ASSEMBLYAI_API_KEY=`. Paste your
key there, or run `aai login` to store one globally. Nothing will run until you
do. Keys live at
[www.assemblyai.com/dashboard](https://www.assemblyai.com/dashboard).
:::

The agent it writes is five files:

```text
my-agent/
  agent.ts            # the definition
  system-prompt.md    # the prompt — discovered, not imported
  tools/
    get_weather.ts    # one tool; the filename is its name
  agent.test.ts       # ordinary vitest — `aai test`
  agent.eval.test.ts  # does it BEHAVE — `aai eval`
```

The usual project files (`package.json`, `tsconfig.json`, `.env`) come with
them. Nothing in the five names another: the prompt and the tool are found
where they sit.

Run `aai templates` to see the other starting points. Pass
`--template pizza-ordering-agent` to pick one.

## 2. Talk to it

```sh
aai dev
```

That starts a local server and prints a URL. Open it, click the microphone, and
ask it about the weather somewhere. It rebuilds when you save, so leave it
running for the next two steps.

## 3. Change what it says

The agent's personality lives in two files.

`agent.ts` is the definition — three fields, all yours to change:

```ts
// agent.ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Weather Line",
  greeting: "Weather line — which city are you asking about?",
  voice: "michael",
});
```

`system-prompt.md` is the prompt. It is plain markdown, and nothing imports it.
The build finds it because it sits beside `agent.ts`:

```md
<!-- system-prompt.md -->
You help callers plan around the weather.
Answer in one or two sentences — this is a phone call, not a paragraph.
```

Save either one and the running `aai dev` picks it up.

## 4. Give it something to do

A tool is a file in `tools/`, and the filename is the name the model calls it
by. So the one you already have is `get_weather`. Open it — comments aside,
this is all of it:

```ts
// tools/get_weather.ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

type Wttr = {
  current_condition?: [{ temp_F?: string; weatherDesc?: [{ value?: string }] }];
};

export default tool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().describe("City name, e.g. Denver") }),
  execute: async ({ city }, ctx) => {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      signal: ctx.signal,
    });
    if (!res.ok) return { error: `The weather service answered ${res.status}.` };
    const now = ((await res.json()) as Wttr).current_condition?.[0];
    return { city, tempF: now?.temp_F, conditions: now?.weatherDesc?.[0]?.value };
  },
});
```

Three habits in it are worth copying into your own tools:

- **The input `z.object` is what the model fills in**, and `.describe()` is what
  it reads. Spend a sentence on each field.
- **Pass `ctx.signal` to anything you call.** It carries the call's deadline, so
  a slow service ends the request instead of being waited out and then
  discarded.
- **Return a failure rather than throwing one.** A message the model can read is
  one it can apologize for out loud.

Now copy the file to `tools/get_forecast.ts` and change the description and the
body. The model can call that too. There is nothing to register, no list to
join, and no import to add: a file in `tools/` is a tool because it is in
`tools/`.

## 5. Ship it

```sh
aai login      # once
aai publish
```

`aai publish` uploads your source, syncs the secrets from `.env`, builds it on
the platform, deploys, and prints a URL you can share. That is one command,
including the first time.

See [Publish](/agent/deploy/publish/) for the details, and
[Phone calls](/agent/deploy/phone/) for putting it on a phone number.

## Next

- [How it works](/agent/start/how-it-works/) — why the project is shaped this way
- [Tools](/agent/build/tools/) — talking to your own APIs
- [Remembering things](/agent/build/state/) — state that survives the call
