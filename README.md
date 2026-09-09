# aai

Voice agent development kit for TypeScript. An agent is a directory of files —
talk to it in your browser, put it on a phone number, and ship it with one
command.

Documentation: **<https://alexkroman.github.io/agent/>**
· [Quickstart](https://alexkroman.github.io/agent/start/quickstart/)
· [SDK reference](https://alexkroman.github.io/agent/reference/)

## Installation

```sh
npm i -g @alexkroman1/aai-cli
```

Requires Node.js 24+ and an `ASSEMBLYAI_API_KEY` — one key covers
speech-to-text, the model, and text-to-speech.

## Usage

```sh
aai init my-agent
cd my-agent
aai dev        # local dev server + browser voice client
aai publish    # ship it
```

`aai init` scaffolds from a template (`aai templates` lists them) and writes a
`.env` for your key.

## An agent

`agent.ts` — the definition. With no provider fields it runs the default
all-AssemblyAI pipeline:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Weather Line",
  greeting: "Weather line — which city are you asking about?",
  voice: "michael",
});
```

`system-prompt.md` — the prompt. Nothing imports it; the build finds it because
it sits beside `agent.ts`:

```md
You help callers plan around the weather.
Answer in one or two sentences — this is a phone call, not a paragraph.
```

`tools/get_weather.ts` — a tool is a **file**, and the filename is the name the
model calls it by. `agent()` takes no `tools` field:

```ts
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

That is a working agent. `aai dev` serves it with a browser voice client and
rebuilds on save.

## What the runtime handles

A spoken conversation has failure modes a chat UI doesn't. These are on by
default, each with a named field on `agent()` when you disagree:

- A cough or a backchannel doesn't cut the agent off mid-sentence.
- An interruption that never becomes a real turn resumes the reply from the
  last words the caller actually heard.
- A slow tool chain speaks a short filler instead of leaving dead air.
- An interrupted reply is recorded as what the caller *heard*, so the model
  doesn't think it delivered information that never arrived.
- A provider error is handed back out loud rather than dying silently.

The numbers behind the defaults are measured, and each constant's own doc
carries the run behind it. See
[How it works](https://alexkroman.github.io/agent/start/how-it-works/).

## Beyond the basics

Each of these is one page in the docs:

| | |
| --- | --- |
| [Tools](https://alexkroman.github.io/agent/build/tools/) | Ordinary async functions, plus `resolveOne` for matching what a caller *said* |
| [Session state](https://alexkroman.github.io/agent/build/state/) | `sessionSlot()` — durable across a crash or a redeploy |
| [Testing](https://alexkroman.github.io/agent/build/testing/) | `aai test` is vitest; `@alexkroman1/aai/testing` supplies the collaborators |
| [Voices and models](https://alexkroman.github.io/agent/more/voices-and-models/) | Swap STT, the LLM, TTS — or all three for one speech-to-speech socket |
| [Phone calls](https://alexkroman.github.io/agent/deploy/phone/) | Twilio and Telnyx; nothing below the bridge knows it's a phone call |
| [Background jobs](https://alexkroman.github.io/agent/more/background-jobs/) | Durable, journaled workflows for work that outlives a turn |
| [Your own UI](https://alexkroman.github.io/agent/more/custom-ui/) | React hooks and components, or a framework-agnostic session |
| [Deploy anywhere](https://alexkroman.github.io/agent/deploy/anywhere/) | `aai build --target vercel\|deno\|modal\|node`, and the commands to ship it |
| [Self-hosting](https://alexkroman.github.io/agent/more/self-hosting/) | The same runtime in your own Node process |

## Packages

| Package | What it is |
| --- | --- |
| [`@alexkroman1/aai`](./packages/aai/README.md) | The SDK: `agent()`, `tool()`, `sessionSlot()`, provider factories |
| [`@alexkroman1/aai-ui`](./packages/aai-ui/README.md) | Browser client: React components, hooks, and the session core |
| [`@alexkroman1/aai-runtime`](./packages/aai-runtime/README.md) | The host runtime — the thing that runs an `agent.ts` |
| [`@alexkroman1/aai-cli`](./packages/aai-cli/README.md) | The `aai` CLI: init, dev, test, build, publish, secret, logs |

## Contributing

[`AGENTS.md`](./AGENTS.md) is the guide for working on the framework itself.
[`scaffold/CLAUDE.md`](./packages/aai-templates/scaffold/CLAUDE.md) is the full
authoring guide for building agents, and ships inside the SDK as
`AGENT_GUIDE.md`.

## License

MIT
