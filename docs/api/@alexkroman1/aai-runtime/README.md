# @alexkroman1/aai-runtime

The host runtime for [AAI](https://github.com/alexkroman/agent) agents: the
thing that actually runs an `agent.ts`.

```ts
import { createAgentServer } from "@alexkroman1/aai-runtime";
```

You need this package if you are **embedding or self-hosting** an agent — it is
what `aai dev` and the managed platform both run, and what a scaffolded
project's `server.mjs` imports.

You do **not** need it to write an agent. Authoring is
[`@alexkroman1/aai`](https://www.npmjs.com/package/@alexkroman1/aai) —
`agent()`, `tool()`, the provider factories — and a browser client is
[`@alexkroman1/aai-ui`](https://www.npmjs.com/package/@alexkroman1/aai-ui).

## Building a server

Three shapes, and the choice between them is **who supplies the agent** — not
how much code you want to write. All three are runnable examples in the repo:

| Example | Who supplies the agent | Where tools run | Entry point |
| --- | --- | --- | --- |
| [`self-hosted-server`][ex-self] | you, at deploy time | in your server process | `createAgentServer` |
| [`host-server`][ex-host] | the caller, per connection | in the caller's process | `createHostServer` |
| [`raw-voice-agent-api`][ex-raw] | the browser, no SDK at all | in the browser | — (no runtime) |

The third is here for contrast: it talks to the AssemblyAI Voice Agent API
directly with no SDK, so it uses none of this package. Read it to see what the
other two are abstracting.

### One agent, your infrastructure

This is the flow `aai dev` wraps, called directly — the deployment is one file
beside an untouched `agent.ts`:

```text
agent.ts + tools/  →  withToolsDir()  →  createAgentServer()  →  listen()
```

```ts
import { agent } from "@alexkroman1/aai";
import { createAgentServer, withToolsDir } from "@alexkroman1/aai-runtime";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) throw new Error("Set ASSEMBLYAI_API_KEY — the default pipeline is all-AssemblyAI.");

// In `server.mjs` this is `import agent from "./agent.ts"` — the template
// file, untouched. Every file in `tools/` is a tool, named by its own file
// name (`roll_die.ts` is `roll_die`), and this line is the whole
// registration: it names a DIRECTORY, never a tool, so it is the last time
// you touch it. Adding a tool is adding a file.
const served = await withToolsDir(
  agent({ name: "Simple Assistant" }),
  new URL("./tools/", import.meta.url),
);

const server = createAgentServer({
  agent: served,
  // What tool code sees as `ctx.env`, and where provider credentials resolve
  // from. Nothing falls back to the host's process.env on its own — assemble
  // this yourself, from a vault or a mounted file.
  env: { ASSEMBLYAI_API_KEY: apiKey },
  // The prebuilt browser UI `aai dev` serves, shipped inside aai-ui. Drop it
  // to serve your own static bundle (`clientDir`) or no page at all.
  clientDir: defaultClientDir(),
});

await server.listen(3000);
```

Four things worth knowing before you copy it:

- **`agent.ts` stays server-agnostic.** It declares no tools and imports
  nothing from this package, which is why the same file runs under `aai dev`,
  publishes with `aai publish`, and is served here. Swapping templates means
  replacing that file and nothing else. Only the *enumeration* of `tools/`
  differs off-platform: `aai build` does it in the bundler, because a deployed
  agent is handed one ESM string and has no directory to scan; this process has
  a directory, so it reads it itself.
- **Node 24+ strips types natively**, so the template's `.ts` is imported
  as-is — no build step, and no second copy of your agent in JavaScript to
  drift from the one you deploy.
- **Tools run in this process, on your credentials.** `ctx.env` is the `env`
  you assembled and `ctx.db` is whatever `Db` you passed.
- **`listen()` binds loopback**, because the server has no request
  authentication of its own. Expose it deliberately —
  `listen(port, "0.0.0.0")` behind your own proxy and auth.

### Many agents, one server

[`host-server`][ex-host] inverts the arrangement: the server ships with no
agent and holds no credentials, and each WebSocket connection deploys its own.
The first frame is the handshake, carrying the system prompt, the tool
*schemas* and the provider key that session runs on:

```ts
import { createHostServer } from "@alexkroman1/aai-runtime";

const server = createHostServer();
await server.listen(3000); // ws://127.0.0.1:3000/websocket?host=1
```

Two properties are what make that safe to expose self-serve, and both are
structural rather than configured. `createHostServer()` with no `env` has no
credential to leak and none to spend, so cost lands on whoever opened the
connection; credential names are screened against `ALL_PROVIDER_ENV_VARS`, so a
caller cannot smuggle in a `DATABASE_URL` and have the server open `ctx.db`
against a Postgres it controls. And schemas are not code: each `tool_call` is
relayed back over the socket for the caller to execute, so no tenant code runs
in this process and none of it needs a sandbox.

`defaults` is operator policy — a non-AssemblyAI pipeline, `idleTimeoutMs`,
`builtinTools` — and stands for every tenant; provider descriptors are plain
data, so declaring one still costs no credential. What host mode does *not*
give you is authentication (it authenticates the caller's provider key, not the
caller — add your own via the `upgrade` hook or a proxy), persistence (a
"deploy" lasts one connection), or a managed platform.

The example's [`bench/`][ex-bench] has the measured ceiling rather than an
estimate: on 4 vCPU / 16 GB, **1000 concurrent sessions** at 460 MiB and just
over one core. Marginal cost is ~300 KiB per session, so memory is not the
limit — one event loop is, and `node:cluster` over a shared port scales it
almost linearly.

### Into a stack you already have

Skip the bundled server entirely: `createRuntime` gives you the session core,
and `runtime.startSession(ws)` wires a WebSocket you accepted yourself into it,
behind whatever routing and auth your app already has. `AgentServerOptions` and
`RuntimeOptions` are the two option bags to read — a custom `Db`, `Logger` or
`fetch` is a field on one of them.

Whichever shape you pick, what you give up versus `aai publish` is the
platform's sandbox isolation (the `run_code` builtin refuses to execute outside
one), autoscaling, session brokering and managed secrets. You own hardening.

[ex-self]: https://github.com/alexkroman/agent/tree/main/examples/self-hosted-server
[ex-host]: https://github.com/alexkroman/agent/tree/main/examples/host-server
[ex-raw]: https://github.com/alexkroman/agent/tree/main/examples/raw-voice-agent-api
[ex-bench]: https://github.com/alexkroman/agent/tree/main/examples/host-server/bench

## Why it is a separate package

It was `@alexkroman1/aai/runtime` until the SDK's authoring surface and its
host implementation were split apart. Two things came out of that:

- **The authoring install got lighter.** Every `@ai-sdk/*` adapter and every
  vendor SDK (Deepgram, ElevenLabs, Cartesia, AssemblyAI), plus `ai`,
  `postgres` and `ws`, are runtime dependencies — 21 packages that an
  `agent.ts` never touches. The provider factories return pure descriptors; the
  host is what resolves them into open sockets.
- **The reference got readable.** The runtime is ~220 exports against the SDK's
  ~90, and it was two thirds of a combined API reference aimed at people
  writing agents.

## Modules

- [eval](eval.md)
- [eval/vitest](eval/vitest.md)
- [testing](testing.md)
