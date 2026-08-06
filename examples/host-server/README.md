# Multi-tenant host server

A self-hosted **streaming voice agent API**, in the shape of AssemblyAI's own:
open a WebSocket, send a config frame, and that connection *is* a full voice
agent. The server ships with no agent of its own — the caller brings the
prompt, the tools, and the provider key.

Where [`self-hosted-server`](../self-hosted-server) runs one operator-funded
agent for everybody, this inverts the arrangement: the caller supplies the
agent, the server supplies the voice pipeline.

The whole server is [`server.mjs`](./server.mjs):

```js
import { createHostServer } from "@alexkroman1/aai/runtime";

const server = createHostServer();
await server.listen(3000);
```

Requires `@alexkroman1/aai` ≥ 5.10.0.

```sh
npm install
npm start
```

## The API callers get

One WebSocket endpoint: `ws://host:3000/websocket?host=1`.

The first frame must be the handshake, within 15s. It is the deploy:

```jsonc
{
  "type": "config",
  "host": {
    "systemPrompt": "You are a concise order-status assistant.",
    "greeting": "Hi — I can check an order for you.",   // optional
    "tools": [                                          // schemas, not code
      {
        "type": "function",
        "name": "get_order_status",
        "description": "Look up an order by ID.",
        "parameters": { "type": "object", "properties": { "orderId": { "type": "string" } } }
      }
    ],
    "credentials": { "ASSEMBLYAI_API_KEY": "sk-…" },    // the session runs on this
    "sttPrompt": "order IDs are spelled letter by letter" // optional
  },
  "sampleRate": 16000,
  "ttsSampleRate": 24000
}
```

Then it is an ordinary session: send PCM16 audio as binary frames, receive the
agent's audio back as binary frames and its events as JSON. Two events matter
to a host caller specifically:

| Direction | Frame | Meaning |
| --- | --- | --- |
| server → caller | `{ type: "tool_call", toolCallId, toolName, args }` | Execute this and reply. |
| caller → server | `{ type: "tool_result", toolCallId, result, error? }` | The answer. Unanswered calls reject at 120s. |

Everything else is the standard protocol — `agent_transcript`,
`user_transcript`, `reply_done`, `error`.

## Why it is safe to expose self-serve

**The server holds no credentials.** `createHostServer()` with no `env` has
none to leak and none to spend: a session is only possible when its caller
brings a key, so cost lands on whoever opened the connection. Pass
`env: { ASSEMBLYAI_API_KEY: … }` to add a house account as a fallback — a
caller's own `credentials` still win over it — but understand that any
unauthenticated caller can then spend it.

**Only provider credentials are accepted.** Names are screened against
`ALL_PROVIDER_ENV_VARS`, the allowlist that already bounds
`withHostCredentialFallback`. The block is merged into the env the
per-connection runtime is built from, and that env is read for more than
provider keys: unbounded, a caller could set `DATABASE_URL` and have the server
open `ctx.db` against a Postgres it controls. An unlisted name rejects the
handshake and names itself, rather than being dropped silently.

**No tenant code runs here.** Callers send tool *schemas*; the server relays
each call back over the socket and waits. That is why this needs no sandbox.

**Each connection is isolated.** A single-use runtime is built when the
handshake lands and shut down when the socket closes. That is also the scaling
limit worth knowing: one runtime per live connection.

## What it does not give you

**Authentication.** Host mode authenticates the caller's provider key, not the
caller. `listen()` binds loopback for that reason. Add your own before
exposing it:

```js
const server = createHostServer({
  upgrade(req, socket) {
    if (req.headers.authorization === `Bearer ${process.env.TOKEN}`) return false; // fall through
    socket.destroy();
    return true; // claimed — the session handler never sees it
  },
});
```

**Persistence.** "Deploy" here lasts one connection. There is no registry, no
slug, no stored config — a caller re-sends its agent on every reconnect. If you
want durable per-tenant agents, keep the configs in your own store and have
your client send the right one at handshake.

**A managed platform.** No sandbox isolation (the `run_code` builtin refuses to
run outside one), no autoscaling, no deploy pipeline. Host mode is a
self-hosted feature; deployed platform agents do not accept `?host=1`.

## Configuring the pipeline

`createHostServer()` with no arguments runs the default all-AssemblyAI
pipeline, which is why one caller-supplied `ASSEMBLYAI_API_KEY` covers STT, the
LLM gateway and TTS. To choose your own, declare it in `defaults` — descriptors
are plain data, so this still costs no credential:

```js
import { anthropic } from "@alexkroman1/aai/llm";
import { deepgram } from "@alexkroman1/aai/stt";
import { cartesia } from "@alexkroman1/aai/tts";

const server = createHostServer({
  defaults: {
    stt: deepgram({ model: "nova-3" }),
    llm: anthropic({ model: "claude-sonnet-4-5" }),
    tts: cartesia({ voice: "…" }),
    idleTimeoutMs: 120_000,
  },
});
```

Callers then send the matching keys: `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`,
`CARTESIA_API_KEY`. Anything in `defaults` that the handshake does not own
(`voice`, `idleTimeoutMs`, `minBargeInWords`, `builtinTools`) is operator
policy and stands for every tenant.
