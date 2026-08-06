# Self-hosted agent server

Deploy an **agent template** to your own infrastructure — no managed platform,
no `aai` CLI. This is the flow the CLI's `aai dev` command wraps, called
directly:

```text
agent.ts  →  createRuntime()  →  createServer()  →  listen()
```

Two files:

| File | What it is |
| --- | --- |
| [`agent.ts`](./agent.ts) | The [`simple`](../../packages/aai-templates/templates/simple) template, verbatim — what `aai init` scaffolds. Eight lines, no server code in it. |
| [`server.mjs`](./server.mjs) | The deployment. Imports the agent, wires the SDK runtime and the bundled HTTP + WebSocket server, serves `@alexkroman1/aai-ui`'s prebuilt browser client. |

The split is the point. `agent.ts` knows nothing about being self-hosted — the
same file runs under `aai dev`, publishes to the managed platform with
`aai publish`, and is served by `server.mjs` here. **Swapping in a different
template means replacing one file and nothing else.**

Node 24+ strips the types natively, so the template's `.ts` is imported as-is:
no build step, and no second copy of your agent in JavaScript to drift from the
one you deploy.

## Run it

```sh
npm install
export ASSEMBLYAI_API_KEY=sk-…
npm start
```

Open <http://127.0.0.1:3000> and talk to it. One key is enough: with no
provider fields set, the agent runs the default all-AssemblyAI pipeline (STT +
LLM gateway + TTS on the same key).

## Try another template

Replace `agent.ts` with any of the
[templates](../../packages/aai-templates/templates) — `math-buddy`,
`health-assistant`, `pizza-ordering`, `web-researcher`. Nothing in
`server.mjs` changes. Templates that declare a different provider stage
(`pipeline-simple` uses Anthropic for the LLM) need that provider's key added
to the `env` you pass `createRuntime`.

Adding a tool is a few lines on the agent, and it runs **in this process**, on
your credentials:

```ts
import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";

export default agent({
  name: "Simple Assistant",
  tools: {
    roll_die: tool({
      description: "Roll a single die with the given number of sides.",
      inputSchema: z.object({ sides: z.number().int().min(2).max(1000) }),
      execute: ({ sides }) => ({ rolled: 1 + Math.floor(Math.random() * sides) }),
    }),
  },
});
```

That is the sharpest contrast with [`host-server`](../host-server), where
callers bring their own agent and execute their own tools out over the socket.
Here the tools are yours and they run on your machine.

## Why self-host?

- **Your infra, your rules** — VPC, compliance, data residency; provider keys
  never leave your process.
- **Programmatic control** — `createRuntime` takes the env at runtime (from
  your own secret store), a custom `Db`, `Logger`, or `fetch`; see
  `RuntimeOptions` in the [API reference](https://alexkroman.github.io/agent/).
- **Embeddable** — skip `createServer` entirely and wire
  `runtime.startSession(ws)` into an existing HTTP/WebSocket stack behind your
  own auth.

What you give up versus `aai publish`: the platform's sandbox isolation (the
`run_code` builtin refuses to execute outside one), scaling, session brokering,
and managed secrets. You own hardening — `listen()` binds loopback by default
because the server has no request authentication of its own, so expose it
deliberately (`listen(port, "0.0.0.0")`) behind your own proxy/auth.

## The other two examples

| Example | Who supplies the agent | Where tools run |
| --- | --- | --- |
| **self-hosted-server** (this one) | you, at deploy time | in your server process |
| [`host-server`](../host-server) | the caller, per connection | in the caller's process |
| [`raw-voice-agent-api`](../raw-voice-agent-api) | the browser, no SDK at all | in the browser |

## Custom UI

Point `clientDir` at any static bundle that speaks the session protocol — or
drop `clientDir` and connect programmatically to `ws://host:port/websocket`
(see `@alexkroman1/aai/protocol` for the wire format).
