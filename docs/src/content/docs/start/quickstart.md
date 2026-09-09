---
title: Quickstart
description: Build, run, and publish a working voice agent in about five minutes.
---

You need Node.js 24+ and an AssemblyAI API key. That one key covers
listening, thinking, and speaking.

## 1. Create a project

```sh
npm i -g @alexkroman1/aai-cli
aai init my-agent
cd my-agent
```

`aai init` scaffolds from a template and writes a `.env` with an empty
`ASSEMBLYAI_API_KEY=`. **Fill it in** — paste your key there, or run
`aai login` to store one globally.

Run `aai templates` to see the other starting points;
`--template pizza-ordering-agent` picks one.

## 2. Talk to it

```sh
aai dev --watch
```

That starts a local server and prints a URL. Open it, click the microphone,
and talk.

`--watch` rebuilds when you save; without it, restart to pick up an edit.

## 3. Change what it says

The agent's personality lives in two files. `agent.ts` is the definition:

```ts
// agent.ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Weather Line",
  greeting: "Weather line — which city are you asking about?",
  voice: "michael",
});
```

And `system-prompt.md` is the prompt. It is markdown, and nothing imports it —
the build finds it because it sits beside `agent.ts`:

```md
<!-- system-prompt.md -->
You help callers plan around the weather.
Answer in one or two sentences — this is a phone call, not a paragraph.
```

Save either one and `aai dev --watch` picks it up.

## 4. Give it something to do

A tool is a file in `tools/`. The filename is the name the model calls it by,
so this one is `get_weather`:

```ts
// tools/get_weather.ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Get current weather for a city",
  inputSchema: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => {
    const where = encodeURIComponent(city);
    const res = await fetch(`https://wttr.in/${where}?format=j1`);
    return await res.json();
  },
});
```

Ask the agent about the weather in Denver and it will call this. There is
nothing to register.

## 5. Ship it

```sh
aai login      # once
aai publish
```

That uploads your source, builds it on the platform, deploys, and prints a
URL you can share.

On your **first** publish the secrets from `.env` are attached after the
deploy, so run `aai publish` once more to pick them up. See
[Publish](/agent/deploy/publish/) for the details, and
[Phone calls](/agent/deploy/phone/) for putting it on a phone number.

## Next

- [How it works](/agent/start/how-it-works/) — why the project is shaped this way
- [Tools](/agent/build/tools/) — talking to your own APIs
- [Remembering things](/agent/build/state/) — state that survives the call
