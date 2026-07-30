# Migration to Vercel eve

**Decision (2026-07-30):** AAI moves onto [eve](https://github.com/vercel/eve)
as its agent framework. Eve owns the brain — agent definition
(`instructions.md`, `tools/`, `skills/`), the LLM loop, durable history,
channels, schedules, sandboxed compute, deployment. AAI's voice-oriented
paths stay and become eve extensions: the aai voice stack is how an eve
agent gets ears, a mouth, and real-time turn-taking.

## Architecture

```text
browser (aai-ui client, unchanged)
   │  aai client protocol: JSON events + raw PCM16 over one WebSocket
   ▼
eve app ── agent/channels/voice.ts  →  voiceChannel()   [@alexkroman1/aai-eve]
   │           │
   │           ├─ wireSessionSocket / SessionCore / audio pacer   [aai, kept]
   │           ├─ pipeline transport: STT endpointing, barge-in,  [aai, kept]
   │           │   settle windows, TTS coalescing, hold phrase,
   │           │   dead-air cover, false-interruption recovery
   │           └─ eve turn runner                                  [aai, new]
   │                 run/deliver per committed user utterance
   │                 message.appended deltas → TTS
   │                 cancelTurn on barge-in
   ▼
eve runtime: instructions.md, tools/, skills/, durable sessions, sandbox
```

The seam is `PipelineTurnRunner`
(`packages/aai/host/transports/pipeline-turn-runner.ts`): the pipeline
transport's reply source is pluggable. The default is still the local
`streamText` loop; `createEveTurnRunner`
(`packages/aai/host/transports/eve-turn-runner.ts`) replaces it with an eve
session — `run()`/`deliver()` per user turn, the reply read off eve's
durable event stream (`message.appended` → text deltas, `actions.requested`
/ `action.result` → tool observability, `session.waiting` → turn end +
continuation token, `cancelTurn` ⇦ barge-in). The eve types are structural
(pinned to eve 0.28), so `@alexkroman1/aai` takes no eve dependency; only
`@alexkroman1/aai-eve` (the channel package) does.

## What this branch ships

- `PipelineTurnRunner` seam in the pipeline transport (`llm: null` +
  `turnRunner`), with every other voice path untouched.
- `createEveTurnRunner` — the eve event-stream bridge, unit-tested against
  scripted streams (happy path, tools, failures, barge-in cancellation,
  stale-event gating after a cancelled turn, continuation-token adoption).
- `packages/aai-eve` — `voiceChannel()`: an eve channel exposing the aai
  WebSocket voice protocol, end-to-end tested (fake peer + fake providers +
  scripted eve session → spoken reply frames).
- Removed: the short-lived aai-side `instructions.md`/`tools/`/`skills/`
  authoring conventions — eve's own filesystem conventions replace them.

## Deletion map

"Remove code eve replaces" lands in stages — a subsystem is deletable when
its eve replacement **runs**, not when it is merely planned. Voice-oriented
rows are **kept** by design.

| Subsystem | Replaced by | Status |
| --- | --- | --- |
| aai `instructions.md`/`tools/`/`skills/` conventions | eve filesystem conventions | **deleted (this branch)** |
| `streamText` loop in the pipeline transport | eve harness via turn runner | deletable once the eve app is the only server (the loop still powers `aai dev`/platform today) |
| `agent()`/`workflow()` + manifest/config schemas | `defineAgent` + eve project | after templates/apps migrate |
| `tool()` + tool-executor + builtin tools | `defineTool`, eve skills, eve sandbox `run_code` | after tools migrate |
| `ctx.generate` + `/patterns` combinators | eve subagents / model calls inside eve tools | after tools migrate |
| KV/Vector providers + `ctx.kv`/`ctx.vector` | eve durable state/context (parity TBD) | after audit |
| `send: slack()` channel | eve `channels/slack` | after apps migrate |
| Sync turns (`POST /sync`) + workflow app kind | eve `mode: "task"` runs | after workflow surface moves |
| gVisor sandbox stack (aai-server) | eve sandbox backends (or a gVisor `SandboxBackend` — see open questions) | after platform decision |
| CLI internals (bundlers, dev server, deploy/secret plumbing) + platform server | **the `aai` CLI stays as the customer-facing surface** and becomes an abstraction over eve commands — customers never run the eve CLI. `aai init` scaffolds an eve project with the voice channel preconfigured; `aai dev` wraps `eve dev`; `aai deploy` wraps `eve deploy`/`eve build && eve start`; `aai secret` manages the eve app's env. Only the *internals* (worker bundlers, gVisor deploy pipeline) are deletable | after the eve project scaffold lands |
| Studio coding-agent loop (`studio-agent.ts`, `studio-llm.ts`, `studio-mcp.ts`) | **the studio agent becomes an eve agent** (below) | next phase |
| STT/TTS providers, pipeline transport voice machinery, SessionCore, ws-handler, audio pacer, SSRF, aai-ui client | — | **kept: this is the product** |
| S2S mode (AssemblyAI speech-to-speech) | — | **kept**, but it bypasses any agent loop (STT+LLM+TTS in one provider socket); it becomes a `voiceChannel` mode that never calls into eve |

## Studio on eve (next phase)

The studio coding agent is the best-fit eve workload: a text loop with
tools, durability, and human-in-the-loop — no real-time constraint.
Mapping: system prompt → `instructions.md` (from the scaffold guide);
file tools (`write_file`, `edit_file`, `grep`, …) → `defineTool` over the
workspace store; `test_agent` → eve sandbox; web tools → eve tools (keep
`safeFetch`/SSRF); docs MCP → eve connections; the chat SSE surface →
eve's chat-sdk channel + `eve/react` client. HITL approvals and the
no-self-publish rule map to eve's approval flow. The studio *builds* stop
producing gVisor bundles and start producing eve projects.

## Latency spike results (2026-07-30, eve 0.28, `eve dev`, Node 24, local world)

Measured with a paced fake `LanguageModel` (100 deltas at 20 ms) inside a
real eve app, arrival-stamped through `getEventStream` from a bench
channel route — so the numbers are pure eve overhead, no model variance:

| Metric | Result |
| --- | --- |
| Per-delta stream overhead | **p50 3 ms, p90 4–5 ms, max 12–22 ms** |
| New-session start → first delta (warm) | ~230–240 ms |
| Second turn (deliver on parked session) → first delta | **~265 ms** |

**Verdict: the event stream itself is effectively free for voice; the cost
is per-turn workflow start/resume (~250 ms before the model's first delta
is visible).** Real-world TTFA through eve ≈ model TTFT + ~250 ms + TTS
first-chunk — roughly 250 ms worse than the local loop. Not disqualifying,
but worth optimizing (eve's park/resume path) before deleting the local
`streamText` loop; the turn-runner seam keeps both options open. Numbers
are dev-mode/disk-world — re-measure on the production setup. The
end-to-end run against the AssemblyAI LLM Gateway still needs this
environment's egress policy to allow `llm-gateway.assemblyai.com`.

## Open questions (validate before the big deletions)

1. **Per-turn resume overhead** (see spike results above): can eve's
   deliver→resume path get materially under ~250 ms, or does the voice
   channel need the local loop for latency-critical deployments?
2. **Multi-tenant platform.** Eve's model is agent = app = deployment.
   AAI's managed platform (many tenant agents in one server, no-network
   gVisor guests, credential separation) has no eve equivalent. Either the
   platform becomes an eve-app provisioner, or it stays and only the
   framework layer migrates. A custom gVisor `SandboxBackend` for eve is
   plausible middle ground.
3. **Voice channel auth.** The aai WebSocket was deliberately
   unauthenticated on the platform; inside an eve app the route can (and
   should) gate upgrades — decide the default before publishing
   `@alexkroman1/aai-eve`.
