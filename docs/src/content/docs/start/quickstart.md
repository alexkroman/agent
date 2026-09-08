---
title: Quickstart
description: Build, run, and publish a working voice agent in about five minutes.
---

You need Node.js 24+ and an AssemblyAI API key. One key covers all three
stages of the default pipeline — speech-to-text, the model, and text-to-speech.

## 1. Create a project

```sh
npm i -g @alexkroman1/aai-cli
aai init my-agent
cd my-agent
```

`aai init` scaffolds from a template and writes a `.env` for your
`ASSEMBLYAI_API_KEY`. Run `aai templates` to see the other starting points —
`--template pizza-ordering-agent` picks one.

## 2. Talk to it

```sh
aai dev
```

That starts a local server and opens a browser voice client. Click the
microphone and talk. Edit a file and it rebuilds — no restart.

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
You help callers plan around the weather.
Answer in one or two sentences — this is a phone call, not a paragraph.
```

Save either one and `aai dev` picks it up.

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

There is no `tools` field on `agent()` and nothing to register. Ask the agent
about the weather in Denver and it will call this.

## 5. Ship it

```sh
aai publish
```

That bundles the project, uploads it, syncs the keys from your `.env` as
agent secrets, and prints a URL you can share. See
[Publish](/agent/deploy/publish/) for what happens to your secrets, and
[Phone calls](/agent/deploy/phone/) for putting it on a phone number.

## Next

- [How it works](/agent/start/how-it-works/) — why the project is shaped this way
- [Tools](/agent/build/tools/) — talking to your own APIs
- [Remembering things](/agent/build/state/) — state that survives the call
