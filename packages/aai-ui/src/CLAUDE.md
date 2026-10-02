---
summary: >-
  The module-directory rules (`session/`, `audio/`, `upload/` entered through
  `index.ts` only, and their one-way edges), the client-config lookup, client
  identity and the inbox, the public hooks, the fuzz harnesses, and the
  workflow-app hooks (`useWorkflowRun`/`Submit`/`Stream`/`Progress`, uploads,
  reload recovery) over the workflow HTTP API.
read_when: >-
  adding a module directory or an import across one, editing
  `client-config.ts`, `client-identity.ts`, the inbox (`inbox*.ts`,
  `notice-player.ts`), `context.ts`, a `use-*.ts` hook, a workflow/upload
  module, or a `fuzz-*.test.ts` harness.
---

# `src/` — module directories, hooks and workflow apps

The session core is in `session/CLAUDE.md`, components in
`components/CLAUDE.md`, worklets in `worklets/CLAUDE.md`, capability contracts
in `contracts/CLAUDE.md`.

## Module directories

Three directories under `src/` are MODULES, each entered through its `index.ts`
only: `session/` (the session core — its rules are in `session/CLAUDE.md`),
`audio/` (the `VoiceIO`, the capture primitives and the pre-connect capture,
beside `worklets/`) and `upload/` (the workflow hooks' upload id claiming, pause
gate, recall and report coalescing).

- **A sibling of `index.ts` is private** — "not re-exported there" — and
  guard-invariants rule 37 fails an import from outside the directory that names
  one (specs and test helpers included); konsistent
  `ui-module-dir-entered-through-index` states the same rule per directory. A
  directory opts in by holding an `index.ts`, so a new one is covered on
  arrival.
- **Inside a directory, names carry no prefix and no underscore**:
  `session/dial.ts`, never a `session-core-` prefixed name; privacy is the
  index's job.
- **`index.ts` is re-export only** (konsistent
  `module-dir-index-is-re-export-only`), which is why `check-module-tests` does
  not ask it for a test.
- **One-way edges**: `audio/` imports neither `session/` nor `upload/`
  (`ui-audio-imports-no-session`) — the session drives the device layer, and
  `audio/` is a lazy chunk the session reaches by dynamic `import()`. `upload/`
  imports neither `session/` nor `audio/` (`ui-upload-imports-no-session`): a
  workflow page has no session.
- **Left flat**: `client-config.ts`, `client-identity.ts` and `types.ts` are
  read by the session AND by the inbox, the mounts and the hooks;
  `_session-core-test-utils.ts` is the socket double the inbox and mount specs
  dial through too. The workflow hooks (`use-workflow-*.ts`, `_workflow-*.ts`,
  `_run-controls.ts`, `_submission-state.ts`) stay at `src/` because the
  `use-*.ts` konsistent conventions key on that path.

## Client config lookup (`client-config.ts`)

- **Every request the session makes needs its own deadline.** The lookup runs
  inside partysocket's URL provider, which arms no timeout until the URL
  resolves — a hung fetch means no socket, no retry, "connecting" forever.
  `CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS` (10 s) makes a hang degrade like a failure.
- **The session's per-attempt lookup uses `loadClientConfig`** (`null` = no
  answer), never `fetchClientConfig` (`{}`). Only an ANSWERED lookup with no
  `sessionUrl` and no `sessionToken` may latch `configPerAttempt = false`;
  latching on a failure pins the client to `/:slug/websocket`, whose redirect
  browsers do not follow.
- **The session lookup re-brokers per ATTEMPT** so a reconnect reaches a
  replacement sandbox — never memoize it across the render-time lookup.
  `mountClient()`'s render lookup is skipped when `mountClient({ name })` is set
  (on the platform it is the broker and can boot a sandbox); a custom
  `component` ignores it.
- **`apiUrl` (shown by `ApiUrlChip`) is the long-lived platform endpoint**
  (`wss://host/:slug/websocket`), never the sandbox tunnel URL, which rots.
- **A session ticket is asked for per ATTEMPT** (`session/ticket.ts`):
  `VoiceSessionOptions.token` (told the session the attempt resumes), else the
  attempt's `client-config` `sessionToken`. It rides `Sec-WebSocket-Protocol` as
  `aai.auth.<ticket>` AFTER the plain `aai.session` (both from
  `@alexkroman1/aai/protocol`) — a browser fails a handshake that selects none
  of its offers, and the server selects the plain one so the ticket is never
  echoed. The URL provider STARTS an attempt and the protocol provider reads the
  same one. A getter that throws dials without a ticket (a provider that rejects
  leaves partysocket with no `close`, so "connecting" forever); an injected
  `WebSocket` needs a synchronous one.
- **The last server-issued ticket is the resume credential** on the platform:
  stored beside the session id (`session/resume-store.ts`), presented in
  `SESSION_TICKET_HEADER` on a lookup that resumes, dropped by `forget()`. A
  bound ticket opens its own session, so a failed re-mint is a new session the
  `config` frame names, never a refusal.
- There is no text-only mode; `ChatView` always renders voice `Controls`. The
  endpoint itself is the SDK's ("Pre-connection client config" in
  `packages/aai/src/sdk/CLAUDE.md`).

## Public hooks

- **`BrowserSession` is SEALED** (a type-only `unique symbol` brand; only
  `createBrowserSession` and the in-package `createMockSessionCore` mint one) so
  it can grow. New methods a caller does not always need go on a sub-handle
  (`session.userTurn`), and `SessionActions` is DECLARED, not `Pick`ed.
- **`useConversation()`** returns `{ items, streaming, transcript, thinking }`
  (`items`: `{ kind: "message" }` | `{ kind: "tool" }`) and owns the interleave
  (tool after its `afterMessageId` anchor; an orphan leads), the streaming
  bubble, the transcript row and the thinking-suppression rule. It subscribes
  per field.
- **`useSessionActions()`** is `useSessionCore` narrowed to the eight methods,
  no subscription. Pair it with one-field selectors, `useSessionStatus()` or
  `useSessionError()` — never whole `useSession()` in a chrome.
- **`useUserTranscript()`**: `null` is silence, `""` is speech with no words
  yet. Render on `speaking`; `text` carries the placeholder; `partial` is raw.
- **The `agent_state` frame is keyed by slot name** (`{ [slot]: view }`, the
  agent's `syncState` keys), so every reader selects ONE slot
  (`agent-state.ts`). **`useAgentState(projection)`** is the overload to use: it
  selects `state[projection.key]`, typed and defaulted by the projection,
  memoized on its identity. Export the projection once from the module declaring
  the slot and import it in both `agent.ts` and `client.tsx`.
  `useAgentState("slot", fallback)` is only for a slot whose `create()` is
  expensive to ship to the browser; `useAgentState()` is the whole frame.
  `hooks.test-d.ts` pins all four signatures. **Per-slot re-renders hold because
  of two things together**: `selectAgentState(slot)` is ONE stable selector per
  name, and the session core keeps an unchanged slot's value object across
  pushes (`shareUnchangedSlots`, `session/messages.ts`).
- **State or moment:** if re-rendering after a reload would be RIGHT, it is
  state → a `sessionSlot` read by `useAgentState`. If it would be a lie or a
  nuisance, it is a moment → `useEvent` / `useToolCallStart` (which never
  replays). `entertainment-picks-agent` shows both.
- **`useClientTool(name, handler)`** is the one hook that answers BACK: built on
  `useToolCallStart` (one run per call id; a call still pending at mount is run,
  a completed one is not) and `session.sendToolResult`, which encodes the result
  and turns an unencodable one into an `error` rather than a throw.
- **Theme tokens are CSS variables** (`--aai-bg`, `--aai-surface`, `--aai-text`,
  `--aai-border`, `--aai-primary`, written by `ThemeProvider`, mapped in
  `styles.css`'s `@theme`). Additive: `useTheme()` stays. The page background is
  still painted imperatively on `html` AND `body`; the `styles.css` fallbacks
  must equal `DEFAULT_THEME` (a test compares them); variables are RESTORED on
  unmount, not removed. `theme-css-vars.test.tsx` holds these.
- **`ClientConfig` display fields** (`icon`, `subtitle`, `buttonText`,
  `sidebarPosition`) must be honoured by BOTH `rootFor` branches; `icon` reaches
  the start card and the header. The forwarding bag is a MAPPED type over `Pick`
  because of `exactOptionalPropertyTypes`.
- **Session resume is on by default in `sessionStorage`**
  (`session/resume-store.ts`). Do not wire `onSessionId`/`resumeSessionId` by
  hand, and never into `localStorage` (a stale id suppresses the greeting and
  rejoins a dead context).
- **`usePushToTalk`** drives `session.userTurn` (`start`/`commit`/`clear`) for a
  `turnTaking: { detection: "manual" }` agent; its module doc lists the ways a
  hand-written button leaves a turn open.
- **`useTapToTalk`** is the toggle for an automatic-turn agent. Its decisions
  are a statechart (`_tap-to-talk-state.ts`: a `live` region and a `session`
  region whose `active` children own the hang-up clocks); the hook only feeds it
  `SESSION` on every snapshot activity and runs its effects. **The feed
  subscribes to the session core OUT OF BAND of React** (`feedSession`), so a
  transcript delta restarts a clock without re-rendering the host; React
  subscribes to the phase alone. Hang-up is `disconnect()` (resumable), never
  `end()`; the mute is an ENTRY action of `live`, so no path forgets it; a clock
  hangs up only while not live.
- **`sendText(text, { connect: true })`** queues in the session core (not in a
  hook) and flushes on the next `config` frame; `updateState` empties the queue
  on any `running: false`, so a message typed into a call that failed is never
  answered by a later one.
- **`useConversationLog`** opens NO inbox: a second socket from one tab under
  the same (client, holder) replaces the first, so it hands back `mirror` for
  the page's one `useInbox({ onEvent })`. A resume replays history, so the live
  list is never appended as it stands — the rules are `conversation-log.ts`'s
  module doc, and its property test holds them. A capped `messages` window
  sliding (a very long call) reads as a new `run`.
- **`routeFetch`** resolves `api/…` against the page's DIRECTORY (an agent at
  `/:slug/` reaches `/:slug/api`); `useRoute`'s default `?client=` is the
  session identity's, read per request, and none under `mountPage()`.
  `useRouteMutation` is the write half with the same default: `run` never
  rejects, the error shown is the highest-numbered SETTLED write's, and nothing
  runs after unmount. `useClientRuns` is those two over a `clientRunsRoutes()`
  pair — its row type is the SDK's, re-exported, never restated.

## Client identity and the inbox

A run reaches the page after the call through `WS /inbox?client=` (server half:
`aai-runtime/src/inbox/inbox.ts`; wire: `stepNotifyClient`'s module doc).

- **`client: "auto"` is resolved in `client-identity.ts`**, never in a caller:
  `browserClientId(platformUrl)` is `browser-<32 hex>` in `localStorage` keyed
  by the agent URL (the id is a history credential, so one agent's server must
  not learn another's), minted with `getRandomValues` (`randomUUID` needs a
  secure context; `aai dev` on a LAN is `http:`), per-tab in memory without
  storage. The dialer and `session.identity` read the SAME resolved option.
- **The inbox holder is per TAB** (`inboxHolderId`: browser id + a per-load
  suffix). The inbox REPLACES a socket presenting the same (client, holder), so
  a browser-wide holder had two tabs knock each other off once a second. Pinned
  by `client-identity.test.ts` (two module realms over one storage).
- **`session.identity.sessionId()` is the CONFIRMED id** (the dialer's, set by a
  `config` frame, cleared by `forget()`), not the resume identity — and the
  dialer calls `notify` when it moves, since no snapshot field may move with it.
  `useSessionId`/`useClientId` are `useSyncExternalStore` over that.
- **`createInbox` keeps ONE assembler across reconnects** (`inbox-protocol.ts`):
  the redelivery after a lost ack comes on the next socket, so a per-socket
  repeat memory replays it; only the half-received notice is dropped with the
  socket. A repeat is acked even while busy; a header mid-notice goes unacked.
- **The inbox presents a ticket like the session** (a gated server checks
  `/inbox` like `/websocket`): `createInbox({ token })`, same type and
  per-attempt rule as `VoiceSessionOptions.token`; `useInbox` passes
  `session.identity.ticket()` — the session's `token`, else a FRESH
  `client-config` ticket until a lookup shows the server issues none. A
  synchronous answer dials at once, so an ungated inbox is unchanged.
- **`useInbox` plays through its own `AudioContext`** (`notice-player.ts`, 16
  kHz), unlocked by the first `pointerdown`/`keydown` — the session's context
  exists only mid-call, and a notice arrives when none is. Default `busy` is
  `snapshot.running`.

## Fuzz harnesses

`session/fuzz-session` (frames × controls × socket lifecycle),
`audio/fuzz-voiceio` (enqueue/done/flush/close × worklet stops), `fuzz-hooks`
(exactly-once tool-call/event delivery), `session/fuzz-reconnect` (broker latch,
resume ids, history replay); `worklets/audio-stress.test.ts` for the processors.
They assert INVARIANTS. Beyond "Property tests run on fast-check"
(`.agents/testing.md`):

- **Check sensitivity** — revert the fix and confirm the harness fails. The
  audio mocks accumulate nodes across a test, so a harness can silently drive a
  DEAD worklet node.
- **Stay faithful to the protocol** — one `config` per connection, a drain-stop
  only after a `done`, timers advanced 1 ms per op — or the violations are the
  model's own.

## Workflow apps

A `mode: "workflow-app"` agent (declared with `workflowApp({ name, workflows })`
from `@alexkroman1/aai`) is a web page over the workflow HTTP API: no session,
WebSocket or audio. The routes are served by `aai-runtime/workflow/api.ts`,
whose module doc is the authoritative table; the platform brokers them at
`/:slug/workflows/*`.

### Mounting and factories

- **`mountPage()` is a second mount, never a flag on `mountClient()`** (which
  always builds a `BrowserSession`). `resolveContainer`/`mountRoot` in
  `define-client.tsx` are shared. `template-page-mount.test.ts` (aai-templates)
  checks every template's mount matches its `agent.ts`. `mountPage()` fetches no
  client config — a page wanting `name`/`greeting` calls `fetchClientConfig()`.
- **Server side** (SDK/runtime, stated here because `aai`'s guide is full): a
  static agent's `/websocket` is completed then closed with a protocol error;
  telephony defaults off; it needs NO provider credential
  (`requiredProviderEnvVars` returns `[]`, keyed off `page` because provider
  injection has already happened by preflight; `createRuntime` DEFERS provider
  resolution). `WorkflowAppAgentParams` (`mode: "workflow-app"`) has none of the
  session fields — they are absent, not message-typed.
- **Three factories**: `createAgentClient` (`@alexkroman1/aai/workflow-api`, the
  one to reach for), `createWorkflowApiClient` (the narrow SDK client it wraps),
  `createWorkflowApi` (ours: adds only the base URL from `location`).
- **No route logic in this package.** Every route, the bearer, query encoding,
  the `wait` clamp and 404-as-answer live in the SDK client; a new route or knob
  is added THERE. `WORKFLOW_API_PREFIX` is declared by the SDK.
- **Every run route is one `WorkflowClient` call** — never widen the engine type
  into the WDK journal. No `/signals/:token`, no `/retry`.

### The HTTP API

```text
GET    /workflows                 → { workflows: WorkflowSummary[] }
POST   /workflows/runs            → { runId }   body: { workflow, input?, key? }
GET    /workflows/runs            → { runs }    ?workflow=&key=&limit=
GET    /workflows/runs/:id        → a WorkflowRunSnapshot
DELETE /workflows/runs/:id        → { runId, cancelled }
GET    /workflows/runs/:id/events → SSE: run | done | missing | idle
GET    /workflows/runs/:id/stream → SSE: chunk | done | missing   ?namespace=&startIndex=
POST   /workflows/runs/:id/wake   → { runId, woken }
POST   /workflows/uploads?name=x  → { id, …, complete: true }   body: the file
PUT    /workflows/uploads/:id     → the same, under a caller-chosen id
POST|PUT /workflows/uploads/:id/parts
GET    /workflows/uploads/:id     → the bytes, `Range` honoured
GET    /workflows/uploads/:id/info → { id, name, type, size, complete, ranges }
```

- **`events` is the run's STATE; `stream` is what the run WROTE** via
  `getWritable()`. Stream chunks are RETAINED, so a stream read is also a
  replay.
- `api.watch` / `api.streamOutput` return the raw `Response` because a 404 (an
  older agent) is a normal path this package's hooks fall back from;
  `follow`/`followOutput` are the SDK iterators (not used here).
  `readEventStream` is the one SSE parser — never add a second.
- **`wake`**: `woken: 0` is an answer, like `cancelled: false`.
- **`wait`** (`POST` body / `?wait=`): answers at terminal or budget expiry;
  expiry answers the RUNNING snapshot at 202, never an error.
  `clampWorkflowWait` (`MAX_WORKFLOW_WAIT_MS`, 60 s) applies at both ends. The
  server loop watches the RESPONSE, not the request (a read `IncomingMessage` is
  already `destroyed`), and answers an unknown id at once.
  `useWorkflowSubmit(workflow, { wait })` still follows with `useWorkflowRun`.
- **Auth is fail-open**: the surface is as public as `/websocket`;
  `AAI_WORKFLOW_API_TOKEN` makes every route require a bearer. So `<audio src>`
  / `<a href>` cannot point at an upload — use `api.download` → `Blob` →
  `useDownloadUrl`.
- Run names: the WDK's `workflowName` is the compiler id; ours is the
  `agent({ workflows })` key. `workflow/client.ts` (SDK) translates both ways,
  and its test fake stores runs under the compiler id.

### Watching a run (`useWorkflowRun`)

Event stream first, poll fallback (the poll is the correct default; the stream
saves brokered reads). Every stream failure degrades to polling, and
`watchRunEvents` calls back exactly once. `EventSource` is not used (no
`Authorization` header, own reconnect schedule).

- **Hold the client in a REF** via `useWorkflowApiRef(api)` — required of every
  workflow hook by `ui-workflow-hook-api-ref` (`konsistent.json`).
- **A 404 is stable**: stop after `MAX_MISSING_READS`.
- **Read `polling`, never re-derive it** from the snapshot — a gave-up watch
  leaves `run` undefined. `useWorkflowSubmit`'s `pending` is
  `busy || tracked.polling` for this reason.
- **Every stream ending is named** (`done`, `missing`, `idle`); only `idle`
  hands back to the poll.
- `WorkflowOutputOf<typeof wf>` narrows `run.output` on `"completed"` via a
  type-only import of `agent.ts`.

### Progress (`useWorkflowProgress`)

Reports what the run WROTE (`useWorkflowRun` reports its state).

- **Reads are BOUNDED and re-opened**: a progress stream is never closed (no
  step knows it is last), so the route bounds each read by `streamTail()` and
  `done` carries `complete`; the hook re-opens from where it left off until
  `complete`. Only `dev-workflow.scenario.test.ts` can see a regression here.
- **`supported`** separates "deploy predates streams" (hide) from "nothing
  written yet" (wait). Dropped reads and thrown fetches are retried.
- **Chunks replay from index 0 by default.** A negative `startIndex` is resolved
  on the FIRST read (issued from 0, trimmed); later reads are absolute.
- **One React commit per read, not per chunk.**
- `_repeat-until.ts` is the bounded-read loop; `_workflow-api-ref.ts` the ref
  preamble.
- Write side (every `step*` helper here is on `@alexkroman1/aai/step`):
  `stepReport(line)` writes to the stream AND the server log with `(attempt N)`;
  `stepEmit(namespace, chunk)` writes structured values to a REQUIRED named
  stream (never the default one — a page renders it as text), not logged. Both
  from a STEP only (a body replays), both best-effort; `stubReporter()` asserts
  them in specs. Steps should also use `isTransientStatus(status)` and
  `retryAfter(response)` from `/step` rather than hand-rolling a 408/429/5xx
  split or ignoring `Retry-After`.

### Submitting (`use-workflow-form.ts`, `use-workflow-stream.ts`)

- **`useWorkflowSubmit`**: `pending` covers the RUN, not the POST; drop the
  previous run id BEFORE the next request. Returns `wake()`/`cancel()` bound to
  its run (`_run-controls.ts`, shared because `WorkflowStreamSubmission` aliases
  `WorkflowSubmission`); both answer (`0`/`false`) when there is no run.
  `reset()` puts the FORM back and leaves the run running.
- **The state between submit and run is a statechart**
  (`_workflow-form-state.ts`:
  `idle | recovering | submitting{active,paused} | following | failed`), bridged
  by `_submission-state.ts` for both hooks. The lookup and each submission BODY
  are `fromPromise` invokes, so a superseding `SUBMIT` or a `RESET` stops them —
  no tokens, no `current ?? found`. A body reports through `progress`/`started`,
  refused once its signal aborts; leaving `submitting` (unmount included)
  cancels its gate. Never add a flag beside it.
- **Files**: every `File` in the values is stored via `api.uploadStream()` under
  an id the hook MINTS (so an interrupted upload can resume), then the id is
  substituted and the run started. `WorkflowSubmission.upload` reports bytes and
  drops on the last byte. Byte progress uses `XMLHttpRequest` where available
  (`fetch` cannot observe a request body) — the SDK owns that swap.
- **`useWorkflowStream`**: same surface, but the run starts BEFORE the upload
  finishes (`PUT` under a minted id; the store exposes a growing `size`). It
  puts the id where `uploads` says, WAKES the run when the upload lands, and
  CANCELS the run if the upload fails. Nothing here knows the file is audio.
- **Parallel parts by default**
  (`parallel: { partBytes, concurrency } | false`). The store's `size` is the
  contiguous prefix; outage resume is the SDK's (`aai/sdk/_upload-resume.ts`); a
  form's files stay sequential; it degrades to one request for small files or
  older agents.
- **Pause/resume** (`pauseUpload`/`resumeUpload`, `UploadStatus.paused`) is an
  abort plus the minted id — no new storage. `submit()` stays unresolved across
  a pause; the run is untouched (its idle bound applies); `reset()` ABANDONS
  with no error. `upload/session.ts` keys off the ABORT, not `gate.paused` (a
  double-click reopens the gate before the rejection lands).

### Reload recovery

- **Upload recall** (`upload/recall.ts`, `sessionStorage`): keyed on a
  FINGERPRINT (size, lastModified, type, name) and written BEFORE the first
  byte. A recalled id is a candidate: `claimId` (`upload/files.ts`) reads
  `uploadInfo` first — complete → skip the transfer; unfinished WITH windows →
  resume (`resume: true`); anything else, including unfinished with NO windows
  (a second `PUT` gets 409) → fresh id. Specs that want a second transfer need a
  second file and clear `sessionStorage` between specs. `useWorkflowStream` does
  NOT recall (it would start a second run on the first run's upload).
- **Run recovery**: `useWorkflowSubmit` mints a per-page key in `sessionStorage`
  (`use-run-key.ts`) and calls `find(workflow, key)` once on mount. `key`
  overrides (e.g. an account id); `useRunKey({ storage: "local" })` outlives the
  tab; `recover: false` skips the lookup. `useWorkflowStream` has neither.
- **`useWorkflowRuns(workflow, { limit, key })`** reads history once and returns
  `refresh` (no polling). Each READ bumps a `createEpoch()` generation, not only
  unmount, so a slow earlier read cannot overwrite a newer one.
- **`useDownloadUrl(api, id)`** owns the object URL: `revokeObjectURL` on
  cleanup, a `cancelled` flag against a stale download, and `pending` as its own
  field.

### Upload store (SDK/runtime, for reference)

Uploads need the database (the record is a row, bytes are objects); a deployment
missing either gets `createUnavailableUploadStore`, never a file fallback. Bytes
are chunked (`UPLOAD_CHUNK_BYTES`), range reads slice at the store, the metadata
row is written LAST. Steps read with `stepReadUpload(id, { start, end })`
in-process and write with `stepWriteUpload`. Cap: 2 GiB, `AAI_MAX_UPLOAD_BYTES`.
The platform proxy must pass `Range` in and `Content-Range` / `Accept-Ranges`
out.
