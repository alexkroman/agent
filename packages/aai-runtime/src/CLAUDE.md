---
summary: >-
  aai-runtime's `src/` map — which directory holds what, what stays flat and
  why — plus the cross-directory rules: client surfaces, subagents, egress
  pools, reply metrics
read_when: >-
  adding a module to aai-runtime, or editing a flat `src/` module (`subagent`,
  `step-*`, `_egress-*`, `metrics-*`, `generate`)
---

# aai-runtime `src/`

Package-wide rules (barrels, seams, one copy, invariants) are in the package
guide, [`../CLAUDE.md`](../CLAUDE.md).

## A directory with an `index.ts` is a MODULE

Each directory below is entered through its `index.ts` alone, and a module
not re-exported there is private — so there is no `_` prefix inside these
directories (test scaffolding keeps one: the coverage and lint globs key on
it). `guard-invariants` rule 37 refuses an import from outside that names any
other file, specs included; konsistent's `module-dir-index-is-re-export-only`
keeps each index a list of named re-exports.

| Directory              | Holds                                                                    | Guide                                                   |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `runtime/`             | `createRuntime`, its types, and its per-session wiring                   | [`runtime/CLAUDE.md`](runtime/CLAUDE.md)                |
| `server/`              | `createServerForRuntime`, `createAgentServer`, host mode, session auth      | [`server/CLAUDE.md`](server/CLAUDE.md)                  |
| `session/`             | one session: attach lifecycle, socket adapter, core, emitter, event log  | [`session/CLAUDE.md`](session/CLAUDE.md)                |
| `tools/`               | tool execution, tool speech, the builtin surface, the client-tool broker | [`tools/CLAUDE.md`](tools/CLAUDE.md)                    |
| `transports/pipeline/` | the pipeline transport, one subdirectory per stage                       | [`transports/pipeline/`](transports/pipeline/CLAUDE.md) |
| `uploads/`             | the upload store, its records and its byte backends                      | [`uploads/CLAUDE.md`](uploads/CLAUDE.md)                |
| `text-agent/`          | text mode (`createTextAgent`)                                            | [`../TEXT-AGENT-CLAUDE.md`](../TEXT-AGENT-CLAUDE.md)    |
| `mcp/`                 | MCP clients and the `"mcp"` toolset                                      | —                                                       |
| `platform/`            | the guest's platform calls: route table, platform socket, `platformPost` | —                                                       |
| `inbox/`               | `/inbox` and its holders, the client event feed, the channel outbox      | —                                                       |
| `s2s/`                 | the AssemblyAI S2S wire client                                           | —                                                       |

`providers/`, `transports/` (outside `pipeline/`), `workflow/`, `telephony/`,
`session-state/`, `eval/` and `testing/` predate the rule and hold no index.

**What stays flat, and why**: the six barrels, `internal.ts` and `tracing.ts`
(a published subpath names each file); `logger.ts`, `s2s-config.ts` and the small
leaves every directory imports (`_timer`, `_pcm`, `_base64`, `_ws`,
`_audio-gate`, `_get-or-create`, `_ensure-once`, `_path-decode`,
`_compact-records`, `usage-meter`); `guest-host.ts` (the surface `/internal`
hands the guest); `_egress-*`, `app-db.ts` and
`postgres-db.ts`, which `workflow/` imports and so cannot sit behind `server/`
or `runtime/` without a cycle; `subagent.ts`, whose model resolution would
pull the provider registry into the `tools/` index (and back into the
pipeline); the `step-*` primitives; `generate.ts`; the tracing and metrics
internals; and the test helpers several directories share (`_test-utils.ts`,
`_fake-llm.ts`, `_pipeline-test-fakes.ts`, …). **Before adding a directory,
find what discovers files by NAME** (scans, `guard-invariants-scopes.mjs`,
baseline JSONs) — see "Layout" in [`../CLAUDE.md`](../CLAUDE.md).

## A client's surfaces: `/api`, several inbox holders, a live feed

- **`agent({ routes })` is served at `/api/*` and crosses the bundle as DATA.**
  `runtime/agent-routes.ts` compiles the table at `createRuntime` (a bad key
  fails the boot) and is `runtime.serveRoute`; `server/agent-routes-http.ts` is
  the server's half (the prefix, `MAX_ROUTE_BODY_BYTES`, JSON plus its exact
  `rawBody` for webhook signatures, headers as strings, `?client=`). A
  `routeResponse` is read by brand, and so is a thrown `routeError` (its status,
  not a 500). No auth: as open as the server. On the platform it is
  `direct-dial`, so self-hosted only for now (`aai-server/src/guest/routes.ts`
  says why).
- **`/inbox` keeps one socket per (client, `?holder=`)**: the same pair
  replaces, different holders coexist, none is the default. A notice goes to
  every holder: `acked` on the first ack, `busy` only if all were busy.
- **`?events=1`** adds `inbox/event-feed.ts`'s frames — committed transcripts,
  `tool.called`, reply boundaries, `session_ended`; never results or audio —
  fire-and-forget, dropped past `INBOX_EVENT_BUFFER_LIMIT_BYTES`. The feed is a
  registered cross-copy slot ("The server and the sessions are ONE copy of this
  package" in `../CLAUDE.md`).

## Subagents: `ctx.delegate` is a second tool loop

`subagent.ts` implements `ctx.delegate` (contract: `sdk/speaker.ts` in the
SDK) — any `SpeakerDef` run OFF the line, whether named in code or chosen by a
roster's `delegate` — as the AI SDK's `ToolLoopAgent`-inside-a-tool pattern,
with the runtime supplying what an author would get wrong:

- **The model** resolves through `resolveLlm` with the agent env — a hand-built
  agent would read `process.env`, which holds no user keys on the platform.
- **The tools** go through `executeToolCall` (coercion, validation, deadline,
  real `ToolContext`, failure-as-result), as a `"subagent"` toolset ahead of a
  `"builtin"` one.
- **The step budget** spends its last step with `toolChoice: "none"`
  (`forceFinalAnswer`), so a capped subagent ANSWERS.
- **A guardrail**: `SpeakerDef.guardrail` may complain; `runUntilAccepted`
  re-runs with the rejected answer and complaint appended to the SAME
  conversation. Exhausting `maxRevisions` (default 1) returns the last attempt
  with `accepted: false`, never a throw.
- **`expectedOutput`** is appended as `## EXPECTED OUTPUT`, before per-call
  `context`.

Rules:

- **`SubagentRunner` takes `ToolCallDefaults`**
  (`Omit<ExecuteToolCallOptions, "toolset">`, declared in `tools/executor.ts`),
  so a capability added to a tool context cannot be missing from a delegated
  one.
- **The context is the parent's minus `ctx.messages`** — same `env`, slots,
  `db`, `sessionId`; `DelegateOptions.task` must be a complete brief.
- **Budget**: a delegated run spends on the DELEGATING session's meter per step
  (`ExecuteToolCallOptions.usage`) and is refused before each attempt once it is
  gone. A sessionless parent (`step-delegate.ts`) has no meter: uncounted,
  never refused. `usage-meter.ts`'s header lists what feeds the meter.
- **One level deep**: a subagent's tools get a `ctx.delegate` that rejects with
  `NESTED_DELEGATE_MESSAGE` (the refusal replaces the runner, so the message
  says why).
- **What crosses back is the answer plus a cost report, never a transcript** —
  `DelegateResult.toolCalls` carries calls, not results.
- A step delegates too (`step-delegate.ts` fills an SDK `Symbol.for` slot,
  sessionless). A step's subagent gets MCP tools from `stepMcp` (`step-mcp.ts`,
  the same kind of slot), which calls `connectMcpServers` — the core
  `withMcpTools` runs at host start — with the step's `clientId`, and rejects
  instead of degrading when a server is unavailable. A roster's non-speaking
  entries are lowered to one ordinary `delegate` tool in `agent()`
  (`sdk/roster-tools.ts`) — no branch here.
- Wired in `setupSubagents` (`runtime/tools.ts`, sandbox and self-hosted) and
  `createTextAgent`; `createSubagentRunner` memoizes models per descriptor
  object.
- **Tests never run a model**: `createScriptedOneShotModel` (`_fake-llm.ts`)
  here, `stubDelegate` (`@alexkroman1/aai/testing`) on the SDK side.
- The worked example is the `topic-briefing-agent` template (context isolation,
  parallel fan-out with `allSettled`, per-subagent tools and models).

## Every call this runtime makes of its OWN goes through a POOL, and there are two

`_egress-fetch.ts` holds `rpcFetch` (platform routes — the fallback under the
multiplexed platform socket, see
[`PLATFORM-SOCKET-CLAUDE.md`](../../aai-server/PLATFORM-SOCKET-CLAUDE.md)) and
`blobFetch` (window bytes); `_egress-pool.ts` builds them and `step-fetch.ts`
takes a third. **`globalThis.fetch` is banned here by
`guard-invariants` rule 29.** Both default to HTTP/1.1: under HTTP/2 concurrent
requests share one flow-control window and a capacity limit arrives as a
status-less reset (`sdk/step-fetch.ts` has the measurement).
`AAI_EGRESS_RPC_HTTP2` switches the RPC pool only.

- **Per PROCESS, a lazy singleton**; `closeEgressFetch()` RESETS rather than
  poisons it.
- **undici timeouts stay at their 300 s defaults**: callers bound the request
  (`BYTE_OP_TIMEOUT_MS`, `PlatformCall.timeoutMs`) and body-inactivity is the
  only limit on draining. The step pool raises both to
  `STEP_FETCH_INACTIVITY_MS`.
- **The `fetch?:` seam stays optional** — `createHttpUploadBackend` is a
  published export.
- **Bodies must be plain** (`Uint8Array` or string): through `pinnedFetch`, a
  global `FormData`/`Blob`/`Headers`/`Request` is silently stringified
  (`host/_undici.ts`). `providers/_openai-stream-repair.ts` is the one
  baselined exception.

## A reply's metrics are ONE frame, and every reader takes it from there

`metrics.collected` is reported once per settled pipeline reply;
`transports/pipeline/turn/metrics.ts` assembles it from marks the existing
producers already take (`transports/pipeline/llm/trace.ts`, `transports/pipeline/output/audio-out.ts`).

- **A stage that did not happen is ABSENT, never zero.**
- **STT marks are QUEUED per committed text and CLAIMED by the turn answering
  it**; a partial is forgotten when its utterance closes.
- **Tokens are the meter's DELTA across the reply**, so `ctx.generate` counts.
- Readers: the client, `agent({ events })`, and process-wide sinks in
  `metrics-sink.ts` (`registerMetricsSink`, `/metrics`), on the registered
  `metricsSinks` slot because an agent's own code may register one from the
  bundle's copy. `startTracing` registers `otelMetricsSink`
  (`_metrics-otel.ts`); a missing metrics peer is a warning, never a throw.
- S2S and text mode emit no frame yet (the `turnMetrics` capability row in
  `transports/CLAUDE.md`).
