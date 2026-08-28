# Self-hosted agent server

Deploy an **agent template** to your own infrastructure — no managed platform,
no `aai` CLI. This is the flow the CLI's `aai dev` command wraps, called
directly:

```text
agent.ts + tools/  →  withToolsDir()  →  createAgentServer()  →  listen()
```

Three things:

| Path | What it is |
| --- | --- |
| [`agent.ts`](./agent.ts) | The [`simple`](../../packages/aai-templates/templates/simple) template, verbatim — what `aai init` scaffolds. Eight lines, no server code in it, and no list of tools. |
| [`tools/`](./tools) | One file per tool. [`roll_die.ts`](./tools/roll_die.ts) is the tool `roll_die`; the file name is the name the model calls. |
| [`server.mjs`](./server.mjs) | The deployment. Imports the agent, discovers `tools/`, wires the SDK runtime and the bundled HTTP + WebSocket server, serves `@alexkroman1/aai-ui`'s prebuilt browser client. |

The split is the point. `agent.ts` and `tools/` know nothing about being
self-hosted — the same files run under `aai dev`, publish to the managed
platform with `aai publish`, and are served by `server.mjs` here. **Swapping in
a different template means replacing the agent and its tools, and nothing
else.**

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

Ask it to roll a twenty-sided die. The number comes back from
[`tools/roll_die.ts`](./tools/roll_die.ts) running in this process — a die
because it is obviously non-deterministic, so hearing one is proof the model
called the file rather than answering out of its own head.

## Adding a tool is adding a FILE

Drop a file in [`tools/`](./tools) and it is a tool. Its name is its file name
and nothing else, there is no list to join, and neither `agent.ts` nor
`server.mjs` changes:

```ts
// tools/lookup_order.ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Look up an order by its number.",
  inputSchema: z.object({ orderNumber: z.string() }),
  execute: async ({ orderNumber }, ctx) => {
    // Your own client and your own credential. There is no `ctx.db`: the
    // platform provisions no database and hands tool code none, so a tool that
    // wants SQL brings a driver (`pg`, `postgres`, a provider SDK) and reads its
    // URL out of `ctx.env`.
    const res = await fetch(`${ctx.env.ORDERS_API}/orders/${orderNumber}`);
    if (!res.ok) return { error: "No such order." };
    return (await res.json()) as { status: string };
  },
});
```

`agent.ts` is untouched, because `agent()` takes no `tools` field on any path —
a map of `name: import` restates what the filesystem already says, and
forgetting an entry is silent. What differs off-platform is only WHO does the
enumeration. `aai build` and `aai publish` do it in the bundler, because a
deployed agent is handed one ESM string and has no directory to scan. This
process has a directory, so it reads it itself, in the one line `server.mjs`
spends on tools:

```ts
import { agent } from "@alexkroman1/aai";
import { createAgentServer, withToolsDir } from "@alexkroman1/aai-runtime";

// …in server.mjs, `agent` is `import agent from "./agent.ts"`.
const served = await withToolsDir(agent({ name: "Simple Assistant" }), new URL("./tools/", import.meta.url));

const server = createAgentServer({ agent: served, env: { ASSEMBLYAI_API_KEY: "…" } });
await server.listen(3000);
```

That line names a directory, never a tool, so it is the last time you touch it.
A file whose name no provider would accept, one that forgets its default
export, or one hiding a directory deeper is an error at startup — never an
agent that silently cannot do the thing.

Tools run **in this process**, on your credentials: `ctx.env` is the `env` you
assembled, and `ctx.db` is whatever `Db` you passed. That is the sharpest
contrast with [`host-server`](../host-server), where callers bring their own
agent and execute their own tools out over the socket.

## Try another template

Replace `agent.ts` with any of the
[templates](../../packages/aai-templates/templates) — `math-buddy`,
`health-assistant`, `pizza-ordering`, `web-researcher`. Nothing in
`server.mjs` changes. Templates that declare a different provider stage
(`pipeline-simple` uses Anthropic for the LLM) need that provider's key added
to the `env` you pass `createAgentServer`. A template that ships its own
`tools/` brings that directory along with it; nothing in `server.mjs` changes.

## Why self-host?

- **Your infra, your rules** — VPC, compliance, data residency; provider keys
  never leave your process.
- **Programmatic control** — the env is assembled at runtime (from your own
  secret store), and a custom `Db`, `Logger` or `fetch` is a field on the
  options bag; see `AgentServerOptions` and `RuntimeOptions` in
  `@alexkroman1/aai-runtime`.
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
