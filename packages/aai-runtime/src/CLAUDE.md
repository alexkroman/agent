---
summary: >-
  Rules for aai-runtime's flat `src/` modules: session lifecycle and
  vocabularies, `createAgentServer`, tools, subagents, the prompt suffix,
  dialogs/personas wiring, hook commits, the upload store, egress pools, reply
  metrics
read_when: >-
  editing a `session-*`, `runtime-*`, `server*`/`agent-server*`, `tool-*`,
  `subagent*`, `_upload-*`, `_egress-*` or `metrics-*` module in aai-runtime
---

# aai-runtime `src/`

Package-wide rules (barrels, seams, two copies, invariants) are in the package
guide, [`../CLAUDE.md`](../CLAUDE.md).

## A session reaches its client through ONE lifecycle; the socket is an adapter

`session-attach.ts` is the transport-neutral lifecycle of one client
connection: claim the id (evicting a superseded session on resume), announce
`session.configured`, start under the deadline, buffer input while starting and
replay it once ready, report a failed start, and run end-of-session cleanup
exactly once. It takes a `ClientSink` and returns an `AttachedSession`
(`sendAudio`, `sendCommand`, `detach`, `ended`). The phase machine is
`ws-session-lifecycle.ts`.

- **A new kind of I/O is a new ADAPTER, never a second lifecycle.**
  `wireSessionSocket` keeps only what a socket has (frame parsing, keepalive,
  close codes, the `bufferedAmount` guard in `ws-client-sink.ts`).
  `connectSession(runtime, sink)` is the public adapter for a host with its own
  audio I/O (`aai console`) — a free function because `Runtime` is sealed.
- **Pacing wraps ANY sink** (`paced-client-sink.ts`): turn-closing events wait
  behind held audio, and a cancel or reset discards it.
- **`connectSession` detaches itself when the RUNTIME closes the sink** (resume
  takeover, failed start) — a caller-owned sink has no close event, so without
  it the session would sit `ready` forever.
- Telephony is the one remaining fake-socket path; see
  [`telephony/CLAUDE.md`](telephony/CLAUDE.md).

## The session takes two VOCABULARIES, not nineteen callbacks

`ServerSession` takes `command(cmd)` — one `SessionCommand`, what the CLIENT
asks for — and `report(event)` — one `TransportEventBody`, what the TRANSPORT
observed. `TransportCallbacks` is the same `report` from the other side. That
plus the two audio paths is the whole inbound surface. `guard-invariants` rule
16 checks the first rule per file:

- **A callback survives only when there is NO EVENT for it** — binary audio,
  `onReplyStarted` (the wire has no `reply.started`; minting one is a protocol
  change), `onSessionReady`, and socket-lifecycle hooks a caller must ACT on.
- **Report `agent-transcript.committed` or `.updated`, never a boolean.** Only
  the committed one enters history.
- **`reply.completed` is the PROVIDER's claim, not the turn's end** — see
  `session-reply-done.ts`.
- **Audio never joins the hook surface**: `playback_progress` is a
  client→server command and audio frames are binary, so neither is an event.
  Handlers run synchronously off `emit` and async ones are never awaited, so a
  subscriber cannot add turn latency.

`transports/types.ts` holds the boundary and argument; `session-core.ts` and
`session-commands.ts` own the two dispatchers.

## A hook's write needs a commit, and a guard

`agent({ events })` handlers may WRITE session state (authoring half:
`packages/aai/src/sdk/CLAUDE.md`, "A session event hook WRITES state, and still
cannot SPEAK"). Both mechanics live in `session-emitter.ts`:

- **The COMMIT.** `slot.update` is synchronous and cannot flush itself, and the
  tool executor's `finally` is the only other commit point. `runHooks` runs
  `syncStateToClient` then `stateStore.flush` via
  `ToolSetup.commitSessionState`, fire-and-forget (a live call must not wait on
  a round trip). **Only a batch that WROTE pays**: `watchWrites` wraps the
  shared `SlotStore` for one event's handlers — a wrapper, not a flag on the
  store, because the store is shared with the tool executor. An `async`
  handler's late write gets a second chained commit, skipped when nothing more
  was written.
- **The re-entry GUARD.** A commit emits `state.updated`, so a writing handler
  for that event would loop forever. `announcing` is set while hooks run and
  while their commit runs; a nested emit is still recorded and sent to the
  client but announces nothing. Removing it makes `session-emitter.test.ts`
  overflow the stack — keep that test.

`commitSessionState` is absent on the SANDBOX tool path (the runtime holds no
state there): a hook's write still lands in the store, without the commit.

## `createAgentServer` is the front door

### Self-hosted durable workflows: there is no world to start

The replay engine executes a run in THIS process off the agent's own
`workflows`. What `createAgentServer` owes is:

- **`publishWorkflowStepEnv()` at CONSTRUCTION**, only when the agent declares
  workflows (it writes a module-global, so publishing unconditionally leaks one
  test's env into the next; `unstubEnvs` only undoes `vi.stubEnv`). It
  publishes the AGENT env, not `providerEnv`, so a step sees exactly what `.env`
  declares. Construction, not `listen()`, because a host that binds
  `AgentServer.node` itself never calls `listen()`.
- **The delivery door**: `handleWorkflowRequest` is composed into
  `createRuntimeServer`'s `request` hook, wired identically to `aai dev` and the
  harness, with no `allowRemote` — so `POST /workflow-queue` answers 401 (no
  platform queue to vouch for it; in-process timers deliver).
- **A test must boot a workflow through this door** — `aai-cli`'s
  `e2e.test.ts` and the `pack + build + boot` subset do.
- The scaffold's `server.mjs` promises `PUBLIC_URL` and `DATABASE_URL`
  forwarding; `ensureWorkflowJournalSchema` is on the public barrel for the
  same reason (see "The tables come WITH the database" in
  `workflow/journal/postgres.ts`).
- Host mode (`createHostServer`) wires no workflows: its caller-supplied
  agents declare none.

### A server is HANDED to a serverless host, never started by one

`AgentServer.node` is the wired `node:http` server, because a serverless
platform (Vercel's Node runtime) wants `export default <http.Server>` and binds
the socket itself.

- **`port` is asked of the server, not latched by `listen()`**, and `close()`
  gates on `httpServer.listening`, so a socket bound through `node` is really
  released.
- **Anything `listen()` does that is not the BIND is a bug** — it runs in dev
  and silently not in production. `listen()` is the bind plus the boot line.
- **A serverless host gets no WebSocket** (`/websocket`, `/phone` unreachable);
  the HTTP surface is unaffected, which is all a `page: "static"` app needs.
- **`server.mjs` still calls `listen()`**: `npm start` owns its lifecycle
  (`PORT`, boot line, signal handlers). A serverless deployment is a second,
  tiny entry module, not a mode of that one.

### `createAgentServer` forwards what only it can

An option the front door does not carry is unreachable, because dropping to
`createRuntime` + `createRuntimeServer` means restating every derived field by
hand. So:

- `page` and `telephony` are read off the AGENT (`telephony` defaults to no
  carrier), with an explicit field still winning; `name` and `greeting` are
  derived.
- **`env` is forwarded minus the host gate**, through `agentServerEnv`
  (`server-env.ts`, shared with the guest). `createRuntimeServer` reads
  `AAI_WORKFLOW_API_TOKEN` (closes `/workflows/*`),
  `AAI_SESSION_EVENTS_TOKEN`, and `DATABASE_URL` (where an upload's record
  lives) from it; the host-mode key is excluded because `?host=1` would run a
  caller's agent on the operator's credentials. "Belongs to the other door" is
  not a safe reason to drop an option.
- **`agent-server-forwarding.ts` is the enforcement**: every `RuntimeOptions`
  member is on `AgentServerOptions` or on `UnforwardedRuntimeOption` with a
  reason. `ForwardingGap`, `StaleExcuse`, `RedundantExcuse` and `TypeDrift`
  must be `never`; a violation fails `tsc` and the build (the spec beside it is
  type-level and cannot fail on its own).
- **A forwarding spec must take the door a caller takes**, not call
  `createRuntimeServer` directly.
- Reasons for each unforwarded member (sandbox seams, `stt`/`llm`/`tts`, two
  tuning numbers) are at the deny-list entry. Forward one when somebody needs
  it.

## The system prompt: a keyed suffix over a cached base

**`SessionSystemPrompt.setSuffix(key, render)`** (`runtime-system-prompt.ts`)
is the extension point, and the slot is KEYED so a second installer cannot
silently delete another's suffix. Sources render in KEY order; an empty answer
contributes NOTHING (no blank line, no separator), and an empty suffix returns
the base string itself, so a session with nothing to say is byte-identical to
one with no sources. Adding an installer means picking a key.

The base prompt is cached per calendar day (`buildSystemPrompt` stamps the
date). `agent({ systemPrompt })` takes `AgentSystemPrompt`, whose resolver
needs the SESSION, so it is resolved here; a transport gets the assembled string
or a nullary thunk (`SystemPromptOption`). When each transport resolves is in
[`transports/CLAUDE.md`](transports/CLAUDE.md), "The system prompt is resolved
PER TURN".

## Dialogs are wired to a SESSION here

`runtime-dialogs.ts` bridges `agent({ dialogs })` to the session: events reach
it, per-state deadlines are armed, the active instruction becomes the
`"dialogs"` suffix, and three of five voice knobs apply (the other two are
refused with a warning naming the state). `runtime-dialog-knobs.ts` decides
which; `transports/pipeline-dialog-knobs.ts` applies them. Everything else is
in [`../DIALOG-CLAUDE.md`](../DIALOG-CLAUDE.md).

## Personas are wired to a SESSION here

`runtime-personas.ts` installs the active persona as the `"active-persona"`
suffix (sorting ahead of `"dialogs"`), pushes it to a transport that holds its
prompt as session state only when it CHANGED (re-rendered on `tool.completed`
and `state.updated`), and hands the pipeline the persona's
`toolChoice`/`temperature` as a `prepareStep` preparer between the agent's reset
and the dialog state's (`transports/pipeline-persona-knobs.ts`). A stale slot
answers as the entry persona with a warning, never a throw.

**Do not narrow the tool set per step**: the AI SDK's `filterActiveTools`
narrows the EXECUTION set too, so a call to a hidden tool becomes a
`NoSuchToolError` instead of the SDK gate's handoff refusal. The knobs module
doc carries it.

## Tools

### Tool discovery off the platform

`withToolsDir(def, dir)` (`tools-dir.ts`) turns a DIRECTORY into a tool
registry for a plain Node process (no bundler to glob). It is here because it
needs `node:fs` and dynamic `import()`, and the SDK must stay browser-loadable.

- **It adds a source, never a second set of rules** — naming, spec skip,
  nested-file error, default-export checks and collisions stay in
  `toolRegistry`; the attach stays in `withTools`. `sdk/tool-registry.ts`'s
  module doc states the invariant (every source arrives as `path → module`).
- Module keys are RELATIVE to the scanned directory (an absolute key under a
  directory not named `tools` would read as a nested file).
- The scan is recursive so a nested file hits the nested-file error rather than
  being silently absent; a MISSING directory throws.

### A settled tool call writes a `role: "tool"` message, and the shape has ONE home

- **Build it with `toolResultMessage()` (`_tool-result-message.ts`), never a
  literal.** It caps the result, which keeps live and resumed histories
  byte-identical; every producer (`to-vercel-tools.ts`, `text-agent.ts`,
  `session-tool-steps.ts`, `session-event-history.ts`) goes through it.
- **Read the arm by ROLE, never by the presence of a field** — a completion
  whose `tool.called` fell off the event log has no name.

The two SILENT traps (resume anchors index the client-visible list;
`toModelMessage` maps non-`user` roles to `assistant`, hence `isLlmSeedable`)
are in [`../TOOL-OUTCOMES-CLAUDE.md`](../TOOL-OUTCOMES-CLAUDE.md). Author-facing
account: `packages/aai/src/sdk/CLAUDE.md`, "`ctx.generate`, `ctx.messages`, `ctx.delegate`".

### A tool's throw is CLASSIFIED, and only the author can call one FATAL

`execute` RETURNING a `ToolFailure` means "the model can recover"; a throw is a
bug; `ToolDef.onError` says which kind. `tool-error-policy.ts` decides
(`resolveToolError` → `default` / `recovered` / `fatal`). A tool with no
`onError` behaves as if the field did not exist.

- A fatal verdict stops the turn in pipeline and text mode through
  `FatalToolLatch` (the AI SDK swallows the rejection). `withFatalSignal` folds
  it into the REQUEST signal, never the turn's, or it reads as a barge-in.
- **S2S cannot abort** and degrades to a serialized failure.
- **The wire's `fatal` stays `false` for both arms**: `fatal: true` means the
  SESSION is over and `aai-ui` ends the call.
- The four guard rules are in
  [`../TOOL-OUTCOMES-CLAUDE.md`](../TOOL-OUTCOMES-CLAUDE.md).

### A tool can SPEAK, and a filler line may not open the barge-in gate

`ToolDef.messages` declares `start`, `delayed`, `complete` and `failed` lines;
`tool-messages-runner.ts` speaks them from inside `execute`
(`to-vercel-tools.ts`); the design is on `aai/sdk/tool-messages.ts`.

- **A `role: "assistant"` completion means the model is NOT called again.** The
  line latches `ToolSpeechController.verbatim()`, which `startLlmStream` folds
  into `stopWhen`. The sentence is in no step's response, so
  `consumeLlmStream` APPENDS it to the turn's messages; the latch is per TURN
  (`beginTurn()` clears it).
- **Filler goes out `record: false`, and nothing here may abort anything.**
  START/DELAYED lines use the dead-air flag that
  `HeardTracker.spokeRecordable()` reads, so filler alone never makes a turn
  interruptible. The runner owns no signal, cancels no TTS, flushes nothing; a
  `blocking` wait is an ESTIMATE of spoken length bounded by `pTimeout`, never
  a TTS acknowledgement (touching the reply's lifecycle is what once muted an
  agent for 20+ s).
- The generic dead-air cover stands down while a tool covers its own gap
  (`toolCovering` in `transports/pipeline-stream-parts.ts`).

## Subagents: `ctx.delegate` is a second tool loop

`subagent.ts` implements `ctx.delegate` (contract: `sdk/subagent.ts` in the
SDK) as the AI SDK's `ToolLoopAgent`-inside-a-tool pattern, with the runtime
supplying what an author would get wrong:

- **The model** resolves through `resolveLlm` with the agent env — a hand-built
  agent would read `process.env`, which holds no user keys on the platform.
- **The tools** go through `executeToolCall` (coercion, validation, deadline,
  real `ToolContext`, failure-as-result).
- **The step budget** spends its last step with `toolChoice: "none"`
  (`forceFinalAnswer`), so a capped subagent ANSWERS.
- **A guardrail**: `SubagentDef.guardrail` may complain; `runUntilAccepted`
  re-runs with the rejected answer and complaint appended to the SAME
  conversation. Exhausting `maxRevisions` (default 1) returns the last attempt
  with `accepted: false`, never a throw.
- **`expectedOutput`** is appended as `## EXPECTED OUTPUT`, before per-call
  `context`.

Rules:

- **`SubagentRunner` takes `ToolCallDefaults`** (`Omit<ExecuteToolCallOptions,
  "tool">`, declared in `tool-executor.ts`), so a capability added to a tool
  context cannot be missing from a delegated one.
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
  sessionless). A `subagents` roster is lowered to one ordinary `delegate` tool
  in `agent()` (`sdk/subagent-roster.ts`) — no branch here.
- Wired in `setupSubagents` (`runtime-tools.ts`, sandbox and self-hosted) and
  `createTextAgent`; `createSubagentRunner` memoizes models per descriptor
  object.
- **Tests never run a model**: `createScriptedOneShotModel` (`_fake-llm.ts`)
  here, `stubDelegate` (`@alexkroman1/aai/testing`) on the SDK side.
- The worked example is the `topic-briefing-agent` template (context isolation,
  parallel fan-out with `allSettled`, per-subagent tools and models).

## An upload's bytes are OBJECTS, and its record has two homes

One store (`_upload-store-blobs.ts`) over `UploadRecords` (the record) and
`UploadBackend` (one object per `UPLOAD_PART_BYTES` window). Bytes stay out of
Postgres; `_upload-blobs.ts` carries why.

- **The pairing follows the WORLD, off `DATABASE_URL`: an upload is at least as
  durable as the runs that read it.** With a database the record goes there and
  the bytes need a bucket (no bucket is the one refusal). Without one both go in
  the local data directory (`_upload-files.ts`), and `installWorkflowSupport`
  announces it once.
- **A FINISHED upload is immutable, at both layers.** `assertUploadOpen` throws
  `UploadCompleteError` (409). The KIND refusal is checked first (a finished
  streamed upload keeps its 400), and a re-sent CLAIM naming only windows
  already held at the same lengths is a NO-OP (the completing request is the one
  whose answer can be lost). The byte route refuses independently
  (`aai-server/upload-handler.ts`).
- **A streamed upload's first windows are cut small** — `windows(body, limit,
  grow)` doubles from `UPLOAD_CHUNK_BYTES` to `UPLOAD_PART_BYTES` so `size` (the
  contiguous READABLE prefix) advances. Never count bytes that merely arrived.
  Only a published cut may be non-uniform, because `create` derives boundaries
  from `windowList`.
- **Neither direction takes turns with the socket**:
  `UPLOAD_WINDOW_CONCURRENCY` on write, `UPLOAD_READ_AHEAD` on read, both via
  `mapStream`.
- Upload-id validation at the router is in
  [`workflow/api/CLAUDE.md`](workflow/api/CLAUDE.md).

## Every call this runtime makes of its OWN goes through a POOL, and there are two

`_egress-fetch.ts` holds `rpcFetch` (platform routes — the fallback under the
multiplexed platform socket, see
[`PLATFORM-SOCKET-CLAUDE.md`](../../aai-server/PLATFORM-SOCKET-CLAUDE.md)) and
`blobFetch` (window bytes); `_egress-pool.ts` builds them and `step-fetch.ts`
takes a third. **`globalThis.fetch` is banned here by `guard-invariants` rule
29.** Both default to HTTP/1.1: under HTTP/2 concurrent requests share one
flow-control window and a capacity limit arrives as a status-less reset
(`sdk/step-fetch.ts` has the measurement). `AAI_EGRESS_RPC_HTTP2` switches the
RPC pool only.

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
`transports/pipeline-turn-metrics.ts` assembles it from marks the existing
producers already take (`pipeline-llm-trace.ts`, `pipeline-audio-out.ts`).

- **A stage that did not happen is ABSENT, never zero.**
- **STT marks are QUEUED per committed text and CLAIMED by the turn answering
  it**; a partial is forgotten when its utterance closes.
- **Tokens are the meter's DELTA across the reply**, so `ctx.generate` counts.
- Readers: the client, `agent({ events })`, and process-wide sinks in
  `metrics-sink.ts` (`registerMetricsSink`, `/metrics`), `Symbol.for`-keyed for
  the two-copies reason. `startTracing` registers `otelMetricsSink`
  (`_metrics-otel.ts`); a missing metrics peer is a warning, never a throw.
- S2S and text mode emit no frame yet.
