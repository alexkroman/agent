---
title: Quickstart
description: Build, run, and publish a working voice agent in about five minutes.
---

You need Node.js 24, 25, or 26 and an AssemblyAI API key. One key covers
listening, thinking, and speaking. Get one from the
[AssemblyAI dashboard](https://www.assemblyai.com/dashboard).

## 1. Create a project

```sh
npm i -g @alexkroman1/aai-cli
aai init my-agent
cd my-agent
```

`aai init` writes a starter project and installs its dependencies.

:::caution[Add your API key first]
Open `.env` and paste your key after `ASSEMBLYAI_API_KEY=`. Or run `aai login`
to save one for every project. Nothing runs until you do.
:::

Here is what you get:

```text
my-agent/
  agent.ts            # the definition
  system-prompt.md    # what the model is told
  tools/
    get_weather.ts    # one tool; the filename is its name
  agent.test.ts       # tests — `aai test`
  agent.eval.test.ts  # behaviour checks — `aai eval`
```

`package.json`, `tsconfig.json`, and `.env` come with them. None of the five
files names another: the prompt and the tool are found where they sit.

Want a different starting point? `aai templates` lists them, and
`aai init my-agent --template pizza-ordering-agent` picks one.

## 2. Talk to it

```sh
aai dev
```

That starts a local server and prints a URL. Open it, click the microphone, and
ask about the weather somewhere. Leave it running for the next two steps — it
reloads when you save.

## 3. Change what it says

`agent.ts` is the definition. Change any of it:

```ts
// agent.ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Quickstart Assistant",
  description: "Looks up the current weather for any city",
  greeting: "Hi — I can look up the weather anywhere. Which city?",
  voice: "jane",
});
```

`system-prompt.md` is what the model is told. It is plain markdown, and nothing
imports it — the build finds it because it sits beside `agent.ts`:

```md
<!-- system-prompt.md -->
You are a friendly assistant on a voice call. Keep replies to one or two
sentences — a caller is listening, not reading.

Use the get_weather tool whenever someone asks what it is like somewhere.
```

Save either one and the running `aai dev` picks it up.

## 4. Give it something to do

A tool is a file in `tools/`, and the filename is the name the model calls it
by. So you already have a `get_weather`. A tool can be this small:

```ts
// tools/get_weather.ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().describe("City name, e.g. Denver") }),
  execute: async ({ city }) => {
    const res = await fetch(`https://wttr.in/${city}?format=3`);
    return { report: await res.text() };
  },
});
```

Two things the model reads before it decides to call your tool: `description`,
and the `.describe()` on each input. Spend a sentence on each.

Now copy the file to `tools/get_forecast.ts` and change the description and the
body. The model can call that one too. There is nothing to register, no list to
join, and no import to add.

[Tools](/agent/build/tools/) covers the rest — timeouts, failures, and calling
your own APIs.

## 5. Ship it

```sh
aai login      # once
aai publish
```

`aai publish` uploads your source, copies the secrets from `.env`, builds and
deploys it, and prints a URL you can share. One command, including the first
time.

See [Publish](/agent/deploy/publish/) for the details, and
[Phone calls](/agent/deploy/phone/) for putting it on a phone number.

## Next

- [How it works](/agent/start/how-it-works/) — why the project is shaped this way
- [Tools](/agent/build/tools/) — talking to your own APIs
- [Remembering things](/agent/build/state/) — state that survives the call
