# Dispatch Command Center — no-SDK edition

This is the [`dispatch-center`](../../packages/aai-templates/templates/dispatch-center)
template rebuilt **from scratch against the raw [AssemblyAI Voice Agent
API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/quickstart)**.

It uses **no SDKs and no libraries** — not `@alexkroman1/aai`, not
`@alexkroman1/aai-ui`, not `ws`, not React, not zod, not a bundler. Just:

- **The browser's built-in `WebSocket` and Web Audio API** for the client.
- **Node's standard library** (`node:http`, `node:fs`) for a ~70-line server
  whose only job is to mint a short-lived connection token.

Everything the managed platform normally does for you — the system-prompt
assembly, the tool JSON-Schemas, tool execution, the KV store, the dashboard
UI — is reproduced here by hand so you can see exactly what the platform
abstracts away.

## Architecture

```text
┌──────────────┐   GET /token    ┌──────────────┐   GET /v1/token   ┌─────────────────────┐
│   Browser    │ ───────────────▶│  server.mjs  │ ─────────────────▶│   AssemblyAI token  │
│  (app.js)    │◀─── { token } ──│ (Node stdlib)│◀── { token } ─────│      endpoint       │
└──────┬───────┘                 └──────────────┘                   └─────────────────────┘
       │
       │  wss://agents.assemblyai.com/v1/ws?token=…   (direct, no relay)
       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  AssemblyAI Voice Agent API  — STT + LLM + TTS + turn-taking, all server-side │
└─────────────────────────────────────────────────────────────────────────────┘
```

The secret `ASSEMBLYAI_API_KEY` stays on the server. The browser connects
**directly** to the Voice Agent WebSocket using a single-use token, so there is
no audio relay to maintain — tool calls are handled right in the browser and
sent back as `tool.result`.

## Files

| File | Purpose |
| --- | --- |
| `server.mjs` | Token minter + static file server. Node stdlib only. |
| `public/index.html` | Markup + styles (ported from the template's `client.tsx`). |
| `public/app.js` | Audio capture/playback worklets, the WebSocket session, tool dispatch, and DOM rendering. |
| `public/tools.js` | The 12 dispatch tools as `{ schema, execute }` — JSON-Schema written by hand instead of generated from zod. |
| `public/dispatch.js` | The domain engine (triage scoring, protocols, resource recommendation) + an in-memory KV with `localStorage` persistence. Ported from the template's `shared.ts`. |
| `public/prompt.js` | The system prompt assembled exactly as the platform's `buildSystemPrompt()` does, plus the greeting. |

## Run it

```sh
export ASSEMBLYAI_API_KEY=your_key_here
cd examples/dispatch-center-vanilla
node server.mjs
# open http://localhost:3000 and click "Start Dispatch"
```

Then talk to it: *"Log an incident at Main and 5th, caller reports a cardiac
arrest"*, or *"run the active shooter scenario"*, or *"give me the dashboard."*

## How the wire protocol maps

The whole integration is just a handful of JSON messages over one WebSocket:

**On open** — configure the session (sent once):

```json
{
  "type": "session.update",
  "session": {
    "system_prompt": "…",
    "greeting": "Dispatch Command Center online. …",
    "tools": [ { "type": "function", "name": "incident_create", "description": "…", "parameters": { … } } ],
    "output": { "voice": "david", "format": { "encoding": "audio/pcm" } },
    "input":  { "format": { "encoding": "audio/pcm" } }
  }
}
```

**Streaming audio up** — base64 PCM16 (24 kHz mono), once `session.ready` arrives:

```json
{ "type": "input.audio", "audio": "<base64>" }
```

**Events down** that we handle:

| Server event | What `app.js` does |
| --- | --- |
| `session.ready` / `session.updated` | start the mic, flip UI to *listening* |
| `input.speech.started` | barge-in: flush playback |
| `transcript.user` | render the operator's line |
| `reply.started` | UI → *transmitting* |
| `reply.audio` (`data` field) | feed PCM16 to the playback worklet |
| `transcript.agent` | render the dispatcher's line |
| `tool.call` (`call_id`, `name`, `arguments`) | run the tool locally, reply with `tool.result` |
| `reply.done` | finalize playback, UI → *listening* |
| `session.error` / `error` | surface in the error bar |

**Answering a tool call** — note `result` is a JSON-encoded **string**:

```json
{ "type": "tool.result", "call_id": "call_abc", "result": "{\"incidentId\":\"INC-0001\", … }" }
```

## What's intentionally different from the template

- **No `web_search` / `run_code`.** Those are platform built-in tools the
  template's prompt mentions but its `agent.ts` never registered. Since this
  build has no platform, those prompt sections are dropped (the 12 dispatch
  tools are identical).
- **KV is in-browser.** The platform's per-agent KV is replaced with a `Map`
  persisted to `localStorage`, keeping the same `{ get, set, delete }` surface
  the tools were written against — hence the agent's "restoring operational
  state" greeting still rings true across reloads.
- **State runs client-side.** Because the browser connects to the Voice Agent
  API directly, tool execution and the dashboard both live in the browser; the
  server is only a token minter.
