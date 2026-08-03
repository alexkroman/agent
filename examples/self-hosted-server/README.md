# Self-hosted agent server

Run a voice agent **on your own infrastructure** — no managed platform, no
`aai` CLI. This is the flow the CLI's `aai dev` command wraps, called
directly:

```text
agent()  →  createRuntime()  →  createServer()  →  listen()
```

Everything lives in [`server.mjs`](./server.mjs) (~70 lines): an `agent()`
definition with one tool, the SDK runtime that executes it, and the bundled
HTTP + WebSocket server that hosts voice sessions and serves
`@alexkroman1/aai-ui`'s prebuilt browser client.

## Run it

```sh
npm install
export ASSEMBLYAI_API_KEY=sk-…
npm start
```

Open <http://127.0.0.1:3000> and talk to the agent. One key is enough: with
no provider fields set, the agent runs the default all-AssemblyAI pipeline
(STT + LLM gateway + TTS on the same key).

## Why self-host?

- **Your infra, your rules** — VPC, compliance, data residency; provider
  keys never leave your process.
- **Programmatic control** — `createRuntime` takes the env at runtime (from
  your own secret store), a custom `Db`, `Logger`, or `fetch`; see
  `RuntimeOptions` in the [API reference](https://alexkroman.github.io/agent/).
- **Embeddable** — skip `createServer` entirely and wire
  `runtime.startSession(ws)` into an existing HTTP/WebSocket stack behind
  your own auth.

What you give up versus `aai deploy`: the platform's sandbox isolation
(the `run_code` builtin refuses to execute outside one), scaling, session
brokering, and managed secrets. You own hardening: `listen()` binds
loopback by default because the server has no request authentication of its
own — expose it deliberately (`listen(port, "0.0.0.0")`) behind your own
proxy/auth.

## Custom UI

Point `clientDir` at any static bundle that speaks the session protocol —
or drop `clientDir` and connect programmatically to `ws://host:port/websocket`
(see `@alexkroman1/aai/protocol` for the wire format).
