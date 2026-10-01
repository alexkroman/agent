---
summary: >-
  The SDK's authoring primitives: `AgentDef` field groups, the `/testing`
  helpers, concurrency primitives, session slots, dialogs, `procedure()`,
  `ctx.generate`/`messages`/`delegate`, `speaker()`/`roster()`, `Toolset`, tool
  `messages`, voice presets, persistence, workflow apps and the upload client
read_when: >-
  editing anything under `packages/aai/src/sdk/` — an authoring type, a
  testing helper, a slot/dialog/workflow/upload module
---

# packages/aai/src/sdk — authoring primitives

Everything here is node-free (see "SDK structure" in `packages/aai/CLAUDE.md`).
Providers have their own guide in `providers/CLAUDE.md`.

## `AgentDef` field groups: one module and one rule each

`types.ts` is at the source-length cap, so a group sharing ONE rule is its own
interface that `AgentDef` extends; each rule is DERIVED from the declaration,
so a new field cannot skip it.

| Interface          | Module                  | The rule                                                                                                                        |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `PipelineTuning`   | `agent-tuning.ts`       | pipeline transport or nothing; `turnTaking`/`interruption`/`silence` groups, `interruption` reused per dialog state and persona |
| `AgentMode`        | `agent-mode.ts`         | `mode` picks the `agent()` member, and the wire carries it                                                                      |
| `AgentModelTuning` | `agent-model-tuning.ts` | THIS runtime assembles the request, so **s2s refuses all five**                                                                 |
| `AgentGuardrails`  | `agent-guardrails.ts`   | the only declarations that may STOP a turn                                                                                      |
| `AgentObservation` | `agent-observation.ts`  | the two that deliberately may not                                                                                               |
| `AgentRoutes`      | `agent-routes.ts`       | no session: `/api` handlers, data both ways across the bundle                                                                   |

- `assertSamplingScope` reads `MODEL_TUNING_FIELDS`, whose `satisfies` makes it
  total over `AgentModelTuning` — a knob missing from the table fails to
  compile. `resetToolChoice` defaults **true** and is inert unless `toolChoice`
  demands a call.
- **`AgentModelTuning` extends `ModelTuning`** (`temperature`,
  `maxOutputTokens`, `maxRetries`), which `SpeakerDef` extends minus
  `maxRetries`. A delegated run's guardrail budget is `maxRevisions`;
  `SpeakerDef` re-types `maxRetries` as a message naming it.
- **`SlotToolDef` and `DialogToolDef` are BUILT from `ToolDef`**
  (`Omit<ToolDef, "execute">` + their own `execute`), so a new `ToolDef` field
  reaches both.
- **A guardrail is pipeline-only**; `assertGuardrailScope` refuses s2s (already
  spoke) and text mode (hands its caller the stream) by name.
- **`systemPrompt` takes a RESOLVER** `(ctx: AgentSessionContext) => string`,
  called per model request — `agent-instructions.ts` owns it.

## `agent()`'s legality is a discriminated union, not message types

**A field belongs to the members it appears in, and nowhere else.** Each member
of `AgentParams` is cut from `AgentDef` by subtracting a field-list TYPE
(`PipelineOnlyField`, `TextOnlyExcludedField`, `WorkflowAppOnlyField` in
`agent-params.ts`); `_agent-modes.ts`'s refusal tables `satisfies` a `Record`
over the same types. A new mode-specific field goes in a list — never as a
message-typed key on a member, and never as a hand-kept run-time table. Members
stay CLEAN — no `never` keys: an absent key gives the excess-property error
naming the member, and autocomplete shows only what the mode has. The one
exception is the pipeline member's `s2s?: undefined`, without which `{ s2s }`
missing its `mode` would be absorbed by it when `agent()` resolves against the
whole union. Prove a refusal with `AgentAccepts<X>` (`_test-utils.ts`: the
excess-property rule over every overload), not an expect-error directive —
those count against the escape-hatch ratchet.
`InlineToolsMisuse` and `SyncMutationMisuse` remain: neither is a MODE rule.

**A message arm is defeated by a shape-competing SIBLING arm** (still true of
the two that remain): TypeScript elaborates against the closest arm. Verify any
such message with a real `tsc` run; if nothing can print it, NAME the arms
(`{ reply }` / `{ routes }`, as the testing scripts do).

## Wire-shape rules

- **Tool-call args are coerced before a wire schema.** The AI SDK surfaces an
  unparsable call's `input` as the raw string; every emitter routes args
  through `toArgsRecord` (`_wire-helpers.ts`; non-records → `{}`) and records a
  failed call with an error `result`.
- **Pre-connection client config**: the default page is identical for every
  agent and CSP bars inline scripts, so name and greeting come from
  `GET /client-config` (dev) / `GET /:slug/client-config` (platform,
  unauthenticated). Every server builds the body with `buildClientConfig`
  (`client-config.ts`); the platform PROXIES it from the guest, never from the
  stored config, and degrades to `{ sessionUrl }`. The browser half is
  "Client config lookup" in `packages/aai-ui/src/CLAUDE.md`.

## `/testing` helpers

### Which testing import, by FILE

**A test file imports testing names from two doors:
`@alexkroman1/aai-runtime/testing` (everything that installs nothing) and
`@alexkroman1/aai-runtime/testing/vitest` (everything that installs or
restores, plus the eval suites).** Both are on the runtime because `aai` may
not import `aai-runtime` (the engine and the eval harness are runtime); the
runtime re-exports this package's helpers instead, as the SAME declarations.

| File                         | Import from                               | For                                                                                          |
| ---------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `vitest.config.ts`           | `@alexkroman1/aai/testing/vite`           | `defineAgentTestConfig`                                                                      |
| any spec or eval             | `@alexkroman1/aai-runtime/testing`        | every fake and reader of `/testing`, plus `runWorkflow`, `runTextAgent`, `scriptedTextModel` |
| the same file                | `@alexkroman1/aai-runtime/testing/vitest` | every `install*` of `/testing/vitest`, plus all of `/eval/vitest` (`describeEval`, …)        |
| a harness that is not vitest | `@alexkroman1/aai-runtime/eval`           | the runner-free half of the eval harness                                                     |

The names stay DECLARED (and versioned as `aai:testing`) here on `/testing`
and `/testing/vitest`, which keep working, as does `aai-runtime/eval/vitest`;
templates are held to the two doors by konsistent `template-testing-doors`, and
`aai-runtime`'s `testing-doors.test.ts` holds each door to the lists it carries
— a helper added here needs a line in `aai-runtime/src/testing-barrel.ts` (or
`testing-vitest-barrel.ts`) and in its `aai-runtime:testing-stubs` capability.
`scriptedToolContext` is deprecated for `createToolContext`;
`createRuntimeServer` for `createServerForRuntime`.

### The rules

`testing.ts` is published for an author's own project. **It may not import
`vitest`**; anything that installs or returns a `restore` is on
`/testing/vitest` (konsistent `published-testing-split` and
`sdk-modules-do-not-import-the-test-runner`).
Each helper's doc carries the detail; the rules:

- **`createToolContext(overrides?)`** — full `ToolContext` with inert defaults,
  recording `send` (`ctx.sent`), a real slot store, and a DISTINCT `sessionId`
  per call. Takes `ToolContextOverrides` (each field accepts `undefined`, via
  `omitUndefined`; `testing.test-d.ts` pins its key set to `ToolContext`'s).
  Its `generate`/`delegate` take a SCRIPT or a function; a FUNCTION is always
  the seam itself. `ctx.model`/`ctx.desk` are always present (empty `calls`
  when unwired). `scriptedToolContext` predates this and is deprecated.
- **A script NAMES its shape — `{ reply }` or `{ routes }`** — everywhere one
  is taken; a computed route is `{ reply: (call) => … }`; a bare shape reaching
  the runtime untyped throws at bind.
- **`deployedAgent(def, { tools, systemPrompt })`** takes
  `import.meta.glob("./tools/*.ts", { eager: true })`'s RESULT; a `readdir` +
  `import()` is refused (it loads a second copy of the SDK). Bounded to
  `ToolBearingAgent & { systemPrompt }` so `AgentDef` stays off this contract;
  `expectDeployable` returns the narrow `DeployedConfig`.
- **`runTool(tool, args?, ctx?)`** is typed end to end; the name form answers
  `unknown` (import the tool file instead of casting) and runs through the
  toolset's GATE. Args and ctx are told apart by SHAPE; an omitted context is a
  distinct session.
- **`expectToolOk`** takes ANY tool's result — a dialog envelope unwrapped, a
  plain value passed through — and INFERS: a typed result loses its failure
  arm, `expectToolOk<T>(unknown)` is the claimed form for the name lookup.
  Never copy an `ok<T>()` helper into a spec.
- **`stubGateway`** (global `fetch`, you install) / **`installStubGateway`**
  (global `fetch`, installed) / **`stubGatewayRoute`** (a `stepFetch` route to
  compose); never import the second under the first's name.
- **`expectToolOk`/`expectDialogOk`** fail AT the call quoting the refusal;
  `expectDialogRefused`/`dialogRefusalPattern` mirror them (`_dialog-refusal.ts`
  owns the sentence); `dialogResultSchema` is the envelope as zod.
- **`parseToolInput`/`toolInputIssues`** (and `parseSchemaInput`/
  `schemaInputIssues`) — never reach through `["~standard"].validate`, which
  may be async.
- **`stubTranscribe`** stages a refusal as an HTTP STATUS so the SDK's own
  classifier runs. `stubUploads` answers `{ restore, writes, read }`.
- **`stubSpeech` needs no credential** — it marks its synthesizer
  `keylessSynthesizer` (`step-speak.ts`), so `stepSpeak` hands it `""` rather
  than refusing; `requireApiKey: true` restores the refusal.
- **`stubFetchRoutes`/`installFetchRoutes`** — ONE table for the global fetch
  AND the step fetch (published unless `stepFetch: false`), keys matched by
  `_route-keys.ts` — the one matcher `evalNetwork` imports too (via
  `/host-internal`), METHOD prefix included; unmatched THROWS by default, for
  `routeStepFetch`'s reason. `toStepResponse` drops the body of a null-body
  status (`{ status: 204 }` threw in the `Response` constructor).
- **`createRecordingWorkflows`** records starts and runs nothing; a start is
  readable back as `running`, seeded runs answer `find`/`get`/`recent`. The
  eval's recording client:

  ```text
  describeEval(…, { workflows: () => createRecordingWorkflows({ workflows: def.workflows }) })
  ```

- **`commandedBuiltins`/`expectPromptBuiltinsDeclared`**
  (`testing-prompt-builtins.ts`) — a single-word builtin (`think`,
  `calculate`) counts only where the prose NAMES it: backticks, "the X tool",
  or the object of use/call/invoke. A custom tool of a builtin's name declares
  it. The rule and its misses are on `SINGLE_WORD_POSITIONS`.
- **`runGuardrail(def, text, answer?)`** THROWS on a def with none or a promise
  verdict.
- `createStubWorkflows()` is a flat override map over `rejectingWorkflows`.

## Concurrency primitives (use these, don't hand-roll)

The roster and homes are the **`concurrency-primitives`** konsistent
convention; `guard-invariants` rules 2, 3, 4, 8, 9, 19, 21, 22, 23, 31 catch
hand-rolled copies. Each module doc carries the hazard. `p-timeout` and
`AbortSignal.any` are in `AGENTS.md`; `invariant.ts` (state, not timing) is
"Runtime invariants" in `packages/aai-runtime/CLAUDE.md`.

- **`createEpoch()`** (`epoch.ts`, `/internal`) — staleness guard: capture
  `current()`, check `isCurrent(gen)`, `bump()`. No hand-rolled generation
  counters.
- **`createOwnedMap()`** (`owned-map.ts`, `/internal`) — delete by ownership
  TOKEN so a late teardown cannot evict a successor; `owns()` guards other
  mutations (rule 8).
- **`createCoalescingRunner()`** (`coalescing-runner.ts`, `/internal`) — one run
  in flight, triggers share ONE trailing re-run, rejections never wedge it.
- **`createTurnMachine()`** — in `aai-runtime`'s
  `transports/pipeline/turn/state.ts`; turn state goes through its transitions.
- **`createKeyedLock()`/`withLock`** (`keyed-lock.ts`, PUBLIC) — per-key
  serialization; `timeoutMs` bounds the ACQUIRE (`KeyedLockTimeoutError` → 409).
  Public because **the LLM loop runs a step's tool calls CONCURRENTLY** (rule
  9). For a session-state mutation use `slot.update` instead.
- **`mapConcurrent(items, width, run)`** (`map-concurrent.ts`, `/step`) — a
  WINDOW over a cursor. Replay-safe because the item sequence is a pure function
  of the list; **`run` must issue one step call per item, synchronously**.
- **`mapSettled`/`partitionSettled`** (`map-settled.ts`, `/step`) — one
  `Settled<T, R>` per item, in order; `Infinity` means all at once.
- **`mapStream(source, width, run)`** (`_map-stream.ts`, internal) — the same
  bound over an ITERATOR, results in SOURCE order, every task wrapped to SETTLE
  (a sibling's rejection behind a slow head would be unhandled).
- **`sleep(ms, { signal?, unref? })`** (`sleep.ts`, `/internal`) — the ONE wait
  (rule 19). `unref` is opt-in; an abort resolves. Not a timeout (rule 3), not
  a yield (`flush()`/`tick()`, rule 4).
- **`ToolFailure`/`isToolFailure()`/`toolFailure(message)`** (`utils.ts`) — the
  `{ error }` a tool returns for a failure the MODEL should see. Not
  `serializeToolFailure()` (the pre-serialized wire STRING for a THROWN tool,
  `@internal`; `isToolFailure` of it is `false`, pinned in `utils.test.ts`).
- **`pushCapped(list, item, max)`** — NESTED lists only; a top-level slot array
  declares `caps` on the slot.
- **`omitUndefined()`** (`omit-undefined.ts`, `/utils`) — the optional half of
  an object under `exactOptionalPropertyTypes`. Rule 2's remedy names the three
  sites that keep the long form deliberately — check it before converting.
- **`sessionSlot()`**, **`resolveOne()`** (`spoken.ts`), **`orFail`/`failable`**
  (`tool-failure-flow.ts`, on a named helper, not inside `slot.update`; it
  throws), **`ctx.random`** (`random.ts`; not journaled, not cryptographic) —
  [`AUTHORING-HELPERS-CLAUDE.md`](../../AUTHORING-HELPERS-CLAUDE.md) owns the
  last three.

## A session event hook WRITES state and may SAY, but cannot change the turn

`SessionEventContext` carries no `send`, `generate`, `delegate` or `messages`,
so nothing on the event stream decides what the reply in flight says. It does
carry `slots`: slot and dialog accessors take a `SlotHolder`
(`{ slots, sessionId }`), which a `ToolContext` satisfies. **The line is "cannot
change the TURN", not "cannot write"** — maintaining session state from
`userTranscript.committed` or `tool.called` beats a tool the prompt begs the
model to call.

It also carries **`speech`** (`session-speech.ts`), which stays on the right
side of that line: `say(text)` queues a VERBATIM reply of its OWN behind the one
in flight, and `interrupt()` is the client's `cancel()`, both recorded on the
stream like any reply. The same `SessionSpeech` is `ToolContext.speech` (so a
`createToolContext()` still stands in for a handler's context, recording into
`ctx.said`) and `RouteContext.speech(sessionId)` for a webhook. Rules:

- **Pipeline only.** On S2S `done` settles `"dropped"` (said once at session
  start); neither service speaks host text verbatim. `interrupt()` works in
  every mode.
- **Never throws**, and every "cannot" is an outcome on `done`: `"dropped"` for
  an ended session, blank text, a line taken back or stranded by an interrupt.
- **Never await `done` inside the reply it queues behind** (a tool's
  `execute`, a handler holding that reply) — it waits for itself.
- **A speaking handler can hear itself.** A `say` emits
  `agentTranscript.committed` and reply events AFTER the handler returned, so
  the emitter's re-entry guard does not catch a handler that answers its own
  line; it must key on what triggered it. LiveKit and Pipecat do not guard
  this either. `session-speech.ts` carries the safe pattern.
- **`interruptible: false`** holds the caller's barge-in off for that line
  (`PipelineDialogKnobs.holdFloor`, the `bargeIn: "off"` threshold);
  `interrupt()`, `cancel()` and a typed turn still cut it. **`record: false`**
  tags the caption `recorded: false`, which `historyMessageOf` skips, so the
  line is in no history, live or resumed.
- **`AgentSessionContext` has no `speech`**: a resolver or guardrail runs INSIDE
  the reply. That is the one deliberate difference between the twins, pinned
  in `define-agent-groups.test-d.ts`.
- **A session id is not authorization.** A route must verify the webhook before
  it speaks into a call.

**Write SYNCHRONOUSLY.** A hook's write is committed after the handler returns
(an `await` first delays durability) and is not readable by the turn it
happened in. Commit and re-entry guard: "A hook's write needs a commit, and a
guard" in `packages/aai-runtime/src/CLAUDE.md`.

## A slot OWNS its session state — and stores it

There is no `ctx.state`. Each `sessionSlot()` (`session-slot.ts`, root) owns
its key, default, reads, writes, client projection and STORAGE, so state
survives a crash, redeploy or reconnect. **`session-slot.ts` carries each rule
on the member it governs**:

- **`update` is SYNCHRONOUS over a mutable DRAFT**, stored when it returns — an
  atomic read-modify-write with no lock. Await BEFORE the mutation;
  `slot.updateTool` refuses a thenable body; a nested `update`/`set`/`reset` on
  the same slot THROWS; a throwing mutator stores nothing and does not wedge.
- **`slot.get()` returns a frozen `DeepReadonly<T>`** — mutating it is a compile
  error at every depth and a `TypeError` at runtime. A helper that will not take
  `DeepReadonly<T>` is one that mutates.
- **`slot.set()` stores a COPY** (`privateCopy`), so the freeze never lands on
  the caller's object. A VIRTUAL slot gets the live value, unfrozen.
- **A durable value is checked STRUCTURALLY in every backend** (`Map` → `{}`,
  `Date` → string, `NaN` → null don't throw). Running it in memory too is what
  makes memory a valid double.
- **`syncState` takes `slot.projected`, or a list of them** — callable and
  carrying key and default, so a session that ran no tool still renders.
  `normalizeSyncState` (`_author-conveniences.ts`) resolves it to the record
  keyed by SLOT NAME that `AgentDef.syncState` holds, so the frame is
  `{ [slot]: view }` and the browser selects by the same name; one slot twice
  is refused. The record form and `slot.projection(view)` are `@deprecated`
  (each key repeated its slot's; a composed view is a value both ends name).
- **`caps` bounds a TOP-LEVEL array on every store, AFTER `after`**;
  `SlotCaps<T>` admits only array keys, bad caps refused at declaration
  (`_session-slot-caps.ts`). The hook sees the untrimmed draft.

**The backend is a property of the DEPLOYMENT**, never a slot: Postgres with
`DATABASE_URL`, memory otherwise, the platform backend on the platform —
reported in "Session mode resolved". A per-slot `persist` flag is refused;
`{ durable: false }` declares a VIRTUAL slot (unchecked, unfrozen, uncommitted).

**`SessionStateBackend.countEvents` is `max(event_index) + 1`, not
`count(*)`** — the log may have holes, and a count would re-use an index and
silently drop appends. **Every backend must agree.** Backends, commit point,
fail-open on shape drift and size cap: `aai-runtime`'s `session-state/store.ts`
and `session-state/backends/`. **Persistence is reliable across crashes,
best-effort across redeploys.** **No backend creates tables**: whoever owns the
database applies `sessionStateDdl`.

## Dialogs, `procedure()`, and tools as files

**`dialog()`** gates what an agent may do NEXT, at EXECUTION; `dialog.ts`'s
module doc owns it, `packages/aai-runtime/DIALOG-CLAUDE.md` owns the knobs.

- **Declarable as a plain `{ initial, states }` map** whose states carry a
  declared `instruction?: string` (a typo in untyped `meta` produced refusals
  with no recovery text). Only `structuredClone`-able parts, since the
  snapshot is persisted. The machine overload stays; both forms compile to the
  same machine. Two type traps are argued in `dialog-types.ts`.
- **An `on` key starting with `@` is a SESSION event**
  (`"@session.timedOut"`), kept out of the author's `send` union. A state may
  carry `timeout: { afterMs, send }` and `voice`/`interruption`/`toolChoice`/
  `temperature`, read deepest-first, riding in `meta`. **`after` is REFUSED**
  — the actor is stopped inside its window, so a delay never fires.
- **`tool()`, `dialog.tool`, `slot.tool`, `slot.updateTool` all thread `R`
  out** (`ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>>`,
  `ToolDef<P, R>`), still assignable to the registry.
- **`sendFrom` takes `Exclude<NoInfer<R>, ToolFailure>`**; `NoInfer` stops a
  `sendFrom` above `execute` inferring `unknown`. An inline-arrow `execute`
  still needs `sendFrom` declared BELOW it (else `TS18046`) — see "A `sendFrom`
  goes BELOW `execute`" in `packages/aai-templates/CLAUDE.md`.
- Types sit beside factories: `dialog-types.ts`/`dialog-handle.ts`,
  `session-slot-types.ts`, re-exported from the factories.

**`procedure()`** is one unit of WORK inside a tool call: never stored, may hold
a `GenerateFn`. `run(input, { signal })` is the surface, because `toPromise` on
a STOPPED actor resolves `undefined`. `procedure.ts` owns it.

**A tool is a FILE**: `tools/<name>.ts` default-exporting `tool({ … })`, filled
by `withTools` over a build-enumerated registry. **`agent()` THROWS on a `tools`
key** (`assertNoInlineTools`) because no bundler type-checks user code.
`slot.tool()`/`slot.updateTool()` carry a state type into a tool. `withTools`
stays for non-file registries (the studio's coding agent).

## `ctx.generate`, `ctx.messages`, `ctx.delegate`

- **`ctx.generate`** — one-shot generation. `createGenerateFn` (`aai-runtime`'s
  `generate.ts`) resolves through the same `resolveLlm` registry as the
  pipeline, credentials from the agent env only. Defaults to the agent's `llm`;
  a per-call descriptor or model-id string works for S2S agents holding that
  key. `GenerateOptions.schema` takes a Standard Schema or plain JSON Schema.
  **Detect a zod schema by the `_zod` marker, never `~standard`**
  (`isConvertibleSchema` in `schema.ts`) — zod stamps `~standard` onto its
  `toJSONSchema()` output too.
- **`ctx.messages` has a `"tool"` arm** in all three modes and on resume:
  `{ role: "tool", content, toolName?, toolCallId? }`, capped as
  `tool.completed` caps it. Read it by ROLE (the ids are optional). **It never
  reaches the MODEL** — an orphan `tool` message is rejected by providers.
  `aai-runtime/src/tools/result-message.ts` is the one statement of the shape;
  more in `packages/aai-runtime/TOOL-OUTCOMES-CLAUDE.md`.
- **`ctx.delegate`** runs a `SpeakerDef` OFF the line — a whole tool loop
  (`ToolLoopAgent`) with its own instructions, model, tools and context window;
  `speaker()` (`speaker.ts`) declares one, including `expectedOutput`,
  `guardrail`/`maxRevisions` and `schema`. Host half: "Subagents" in
  `packages/aai-runtime/src/CLAUDE.md`.

## MCP servers: declared here, connected in `aai-runtime`

- **`mcp-config.ts` holds types only** — nothing in `sdk/` opens a socket.
  `url`/`headers` may be RESOLVERS called once per connection with
  `{ clientId, env, signal }`; **`toAgentConfig` strips every resolver and
  every `headers` value** (`wireMcpServers`), so a header credential never
  reaches a stored config. A resolved URL gets the same http(s) check and SSRF
  screen as a literal, and every author header is stripped on a cross-origin
  redirect (`safeFetch`'s safelist, `host/ssrf.ts`).
- **`stepMcp` (`step-mcp.ts`, on `/experimental`) is a published slot** like
  `stepDelegate`: the connector is `aai-runtime`'s `step-mcp.ts` over the same
  `connectMcpServers` core as `withMcpTools`. It REJECTS on an unavailable
  server (a step can retry), where host start degrades (a session cannot wait).

## Composio (`composio.ts`, `composio-api.ts`, `composio-webhook.ts`, on `/experimental`)

`composio({ sessions, sessionStore })` is the Composio Platform client over
`jsonClient`; the webhook half is `composioWebhookRoute` (over `webhookRoute`)
and `ensureComposioWebhook` (a setup script's, not an agent's).

- **The `user` is always the AUTHOR's id**, never a model argument, and
  `disconnect` resolves the account among that user's own; `listApps`
  re-filters `connected_accounts` to the user and `ACTIVE` because a filter
  Composio ignores must not leak another user's account.
- **Sessions: one promise per `(kind, user)` in a `createOwnedMap`, then the
  store; made WITHOUT the caller's signal** (a barge-in must not kill the
  create others wait on). A 404 whose message names the session is remade
  ONCE, and only by the caller still owning the lost id — so concurrent callers
  do not delete a successor. A failed create is not remembered.
- **`execute`'s refusal split is the contract**: a 4xx other than 401/403/429 is
  `{ ok: false }`; those three and 5xx THROW (key, project, rate — not the
  request's fault).
- **No error may carry the key**: `composioApi` rebuilds an `HttpError` that
  echoes it WITHOUT a `cause` (the cause is the unredacted original). The base
  URL is an author literal, `https://` only, so it is not SSRF-screened; the
  session's MCP url is screened by the MCP client like any other.
- App policy (tables, connect hints, watch limits, what an event means) stays
  in the app. `composio.test.ts` / `composio-webhook.test.ts` pin all of it
  with `stubFetchRoutes`.

## `ToolDef.messages` — what a tool SAYS

`tool-messages.ts` declares, `tool-messages-select.ts` chooses (both pure);
`aai-runtime/src/tools/messages-runner.ts` speaks. Kinds:
`start`, `delayed`, `complete`, `failed`.

- **Same timing = VARIANTS (one drawn); different timings = STAGES.** Group
  before the draw.
- **`role: "assistant"` on `complete`/`failed` means the model is NOT CALLED**
  — spoken verbatim, step loop stops. `"system"` rides back as a hint.
- **`start`/`delayed` are FILLER, never recorded** and never count as the agent
  having spoken. Barge-in and `blocking`: "A tool can SPEAK" in
  `packages/aai-runtime/src/CLAUDE.md`.

It rides on `ToolSchema` (via `agentToolsToSchemas`), so it means the same in
`aai dev`, a deployed guest and host mode.

## One `speaker()`, one `roster()` (`speaker.ts`, `roster.ts`)

**A subagent and a persona are one `SpeakerDef`**; where it runs decides what it
is. `roster([...])` is ONE list: a `speaks: true` entry is handed the CALL by the
minted `handoff` (first speaking entry answers), the rest a TASK by the minted
`delegate` (`ctx.delegate`). `agent({ roster })` lowers it into a `"roster"`
toolset (`roster-tools.ts`). Every entry needs a `description` (the only thing
either router reads); a speaking entry's tools have one owner and never a minted
name. The speaker on the line is the `aai.speaker` slot; a dialog state may PIN
a speaking entry (`DialogStateSpec.persona`). **The gate is at EXECUTION with
tools still advertised** (hiding them replaces the named refusal with a generic
error). Runtime half: "A roster's speakers are wired to a SESSION here" in
`packages/aai-runtime/src/CLAUDE.md`.

## Every tool source is a `Toolset` (`toolset.ts`)

Files, builtins, MCP, a roster, a subagent's map: each is a `Toolset` —
`list()` (entries: def + executor + deadline), `gate(name, ctx)`,
`execute(name, args, ctx)` — and `agentToolsToSchemas`/`executeToolCall` read
nothing else. **Composition is first-wins** (`composeToolsets`): files, then
`AgentDef.toolsets` (resolved, never authored — `agent()`'s roster set,
`withMcpTools`' MCP set), then builtins. **`toolEntry` is the only place a def's
identity is read** (the `clientTool` brand → `executor: "client"`). A
`dialog.tool` refuses in its OWN `execute`, with no toolset layer, so the check
travels with the def (specs, subagents). **A refusal is a
`ToolRefusal`** — a `ToolFailure` plus `reason` (`unknown_tool`,
`invalid_arguments`, `cancelled`, `persona`, `dialog`, `roster`); `reason` is NOT
on `ToolFailure` itself, so an author's `{ error }` literal still narrows.
`toolOf` is the lookup (the author's def); `runTool(agent, name)` is the CALL
(gated).

## Speech boundary and voice presets

`spoken*.ts`, `calendar.ts`, `tool-fields.ts`: inbound `resolveOne` (ambiguity
is an ANSWER, never a guess), outbound `spokenMoney`/`spokenDate`/`spokenTime`/
`mintCode`, and one-time codes (`one-time-code.ts`: `mintDigitCode`/`hashCode`/
`codeMatches`, Web Crypto only, the compare shared with `standard-webhook.ts`
via `_timing-safe-equal.ts`).
[`AUTHORING-HELPERS-CLAUDE.md`](../../AUTHORING-HELPERS-CLAUDE.md) owns all of it.

**`agent({ voicePresets: [...] })`** (`voice-presets.ts`) — `echoVerification`,
`speechNormalization`, `natoAlphabet`, composed after `## TOOLS` and before the
author's rules. Each property is a test:

- **A LIST, not a mode** — each is priced separately per request (banded in
  `voice-presets.test.ts`).
- **Canonical ORDER, deduped, absent when empty** — none declared means the
  byte-identical prompt.
- **One PRECEDENCE line above the block**; two deliberately contradict
  `## LISTENING`/`## SPEAKING`, which is why they are opt-in.
- **Prompt layer only** — reaches no TTS engine.
- **Known gap**: nothing addresses a mis-heard name a lookup cannot find
  (`smartMatching` was removed with its runtime producer).

A workflow app refuses the field (`WorkflowAppOnlyField`).

## Persistence

**There is no `ctx.db`, no KV store, no vector store.** A tool that persists
brings its own client and credential. `Db` survives as an `@internal` type for
the runtime's own Postgres consumers (`db.ts`). A type on `ToolContext` is
reachable from six contracts at once — expect that fan-out when changing it.
What persists with no setup: `sessionSlot` state and durable workflow runs. No
template demonstrates cross-session persistence (templates cannot reach a
database) — a known gap.

## Workflow apps and the workflow HTTP API

`mode: "workflow-app"` is a page over the workflow API, declared with
`workflowApp()` (`define.ts`), whose member has none of the fields it cannot
use; `GET /client-config` reports it as `page: "static"`. Author-facing half:
"Workflow apps" in `packages/aai-ui/src/CLAUDE.md`.

- **Read a run's newest line with `ctx.workflows.lastLine(runId)`, never
  `streamTail` + `stream` by hand** — a progress channel is never closed, so
  `stream` on an empty run waits forever. A spec stubs `lastLine` directly.
- **A body takes `WorkflowInputOf<typeof def>`; a `*_status` tool holds
  `WorkflowRunOf<typeof def>`.** A body declaring a wider input compiles
  silently (contravariance). The obvious spelling hits `TS7022`; name the schema
  const and ANNOTATE the def (`packages/aai-templates/FFMPEG-CLAUDE.md`). A
  declared `output` schema is what `WorkflowOutputOf` reads (`workflow.ts`).

### A callback URL comes from `publicWebhookUrl`

`ctx.workflows.publicWebhookUrl(token)` is what a tool hands an external
service; the token is the one the body passed `ctx.waitFor`. A body or step
uses `stepWebhookUrl(token)` (`step-webhook.ts`, `/step`) — a `Symbol.for` slot
a host fills. One claim per run; properties in
`packages/aai-runtime/src/workflow/CLAUDE.md`.

`start(def, input, { key, notify })` makes the starting session take an
unprompted, interruptible turn when the run lands (`Transport.injectTurn`,
pipeline only).

### Run lifecycle helpers: each is COMPOSED, and each has one owner

- **`StartOptions.dedupeKey` DERIVES the run id** (`aai-runtime`'s
  `workflow/dedupe-run-id.ts`): every journal already refuses a second
  `createRun` for one id, so two racing starts meet at one insert and no store
  grew a table. Dedupes against a run in ANY status until it expires.
- **`findByKey`/`cancelAll` are `find`/`cancel` composed**
  (`workflow/client-keyed.ts`) — the key index is `(workflow, key)` in all three
  backends, the platform's table included, so a cross-workflow read is N
  lookups merged once, not a new query.
- **`ctx.poll` is `ctx.step` + `ctx.sleep` under one name**
  (`workflow-poll.ts`), so it journals exactly the hand-written loop's keys; its
  budget is a COUNT (`floor(maxMs / everyMs)` sleeps), replay-safe without a
  `ctx.now` per round. Every `WorkflowContext` (engine, `/testing` recorder,
  eval) delegates to it. `stepPollUntil` is the in-step, wall-clock, non-durable
  sibling.
- **`workflow({ onFailure })` runs in the ENGINE, not a body `catch`**
  (`workflow-failure.ts`, runtime `replay/failure-hook.ts`): only for a throw
  classified as the run failing (never a suspend, cancel, journal failure or
  divergence refusal), as the journaled step `onFailure`, before the failure is
  recorded. Not run for an `output`-schema failure (decided after the walk).
- **`stepSayOnClient`** = `stepSpeak` + `stepNotifyClient` with `data.said`; the
  default rate is `agent({ clientInbox: { sampleRate } })`, published beside the
  step env by `createAgentServer` and `aai dev` (`publishClientInboxDefaults`).
  Audio for an undelivered utterance is held across the step's retries.
  **`stepEnvContext()`** is the whole step env plus the step's signal
  (`StepInfo.signal`) as an `EnvContext`, which a `ToolContext` also satisfies.
- **`ctx.sayOnClient(name, clientId, notice)` is ONE `ctx.step` around
  `stepSayOnClient`** (`workflow-say-on-client.ts`), `id` defaulting to the run
  id and `maxAttempts` to `DEFAULT_CLIENT_DELIVERY_ATTEMPTS`; like `ctx.poll`,
  every `WorkflowContext` delegates to `sayOnClientWorkflow` (`/host-internal`).
  Its failure half is **`sayFailureOnClient({ clientId, event, text })`**
  (`say-failure-on-client.ts`, `/step`), a `workflow({ onFailure })` handler
  (`${runId}:failed`, `data.failed: true`, `spokenErrorReason` handed to
  `text`); `deepResearchWorkflow` takes the same `{ run, maxAttempts }` object
  and hands it to the engine, where a FUNCTION `onFailure` still runs in its
  body `catch`.
- **`stepTextOwner(text, { phone?, links? })`** (`step-text-owner.ts`, `/step`)
  is `text_me`'s rule from a step: `allowedSmsRecipient` over the step env,
  a non-retryable refusal as `{ sent: false, why }`, a transient one thrown
  through `throwStepError`, a missing key FATAL. The env names are
  `_owner-text-env.ts`, which `host/text-me.ts` imports too.
- **`isCallOver(status)`/`CALL_OVER_STATUSES`** (`step-place-call.ts`) are the
  five terminal `PlacedCallStatus`es a dial-and-follow loop stops on.

## Uploads (the client half)

The store and why record and bytes pair off one `DATABASE_URL` are in
`packages/aai-runtime/src/CLAUDE.md`, "An upload's bytes are OBJECTS".

- **`POST /workflows/uploads`** answers once every byte is stored.
  **`PUT /workflows/uploads/:id`** lets the caller name the id first; the record
  exists from the first byte with `complete: false` and a growing `size`.
  **`complete` is the only field a body may exit on** (a stalled `size` is a
  slow link or a dead client). Reader: `step-uploads.ts`.
- **Parts** (`POST …/parts?total=`, `PUT …/parts?offset=`) are the DEFAULT for
  `api.upload(file)` unless `parallel: false`. A part starts on an
  `UPLOAD_CHUNK_BYTES` boundary, and **`size` is the CONTIGUOUS prefix, never
  the sum** — else a reader reads a hole. `complete` = prefix reaches the
  declared total.
- **On the platform the bytes go to a platform route** and a bodyless
  `PUT …&stored=1` claim tells the agent; the store asks the BUCKET for the
  size, never the caller. The claim (`directParts`) picks the path. Batched
  receipts: `UPLOAD_CLAIM_BATCH` / `UploadCreated.claimBatch`.
- **`UploadInfo.ranges`** is for the UPLOADER (resume), only on an unfinished
  parts upload; readers act on `size` alone.
- **Width 8 × 8 MiB** — `UPLOAD_PART_CONCURRENCY`'s doc owns why; read it and
  `scripts/upload-sweep.mjs` (`pnpm bench:uploads`) before moving either.
- **An outage-shaped failure RE-ENTERS the upload with `resume: true`**
  (`_upload-resume.ts`), except an abort (also how PAUSE arrives), a refusal
  status, or an acknowledged-never-written record.
- **The parts path DECLINES rather than fails** (uncuttable body, one-part file
  for `upload`, 404 on declaration), and is the only path that may RETRY — a
  retried single `POST` mints a second upload. `workflow-upload-parts.ts` and
  `aai-runtime/src/uploads/store.ts` carry backoff and `Retry-After`.
