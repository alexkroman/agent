---
summary: >-
  The browser session core (statecharts, fatal latch, handshake guard,
  client-config lookup), the public hooks, the fuzz harnesses, and the
  workflow-app hooks (`useWorkflowRun`/`Submit`/`Stream`/`Progress`, uploads,
  reload recovery) over the workflow HTTP API.
read_when: >-
  editing `session-core*.ts`, `client-config.ts`, `context.ts`, a `use-*.ts`
  hook, a workflow/upload module, or a `fuzz-*.test.ts` harness.
---

# `src/` — session core, hooks and workflow apps

Components are in `components/CLAUDE.md`, worklets in `worklets/CLAUDE.md`,
capability contracts in `contracts/CLAUDE.md`.

## Session core

### A FATAL error survives the frames that follow it

The host's fatal paths `terminate()`, which emits `cancelled` — so the frame
announcing death must not wipe the banner. The fatal branch of
`handleErrorEvent` latches; every recovery path is declined while latched; **only
the next `config` frame clears it** (a completed handshake, per CONNECTION, so a
retry reaching a healthy peer is not pinned to the old banner). A NON-fatal error
(`fatal: false`) is still retired by later activity.

- **`session-core-state.ts` owns `state` and `error`.** The seven `AgentState`
  names are one region; the fatal latch is a SECOND region (`stateIn({ fatal:
  "yes" })`), because it outlives the `error` phase (`error → connecting →
  ready`). Callers send what HAPPENED (`LISTEN`, `ACTIVITY`, `SPEAK`, `THINK`)
  and fold the projection into one `updateState`. Never write `state`/`error`
  directly or guard a write by reading the snapshot back.
- **XState falls through to an ancestor's handler when a child's guard fails**,
  so every handler that clears the banner carries the fatal guard.
- A declined transition returns the position unchanged; `updateState` drops
  snapshots that differ in nothing (pinned by `session-core-events.test.ts`).

### The audio path is a statechart (`session-core-audio-state.ts`)

`down` / `starting` / `up`; bring-up is an `invoke`, so hang-up, reconnect or a
fatal frame STOPS it. `PROGRESS`/`IO_FAILED` carry the instance that fired them
(a repeated `config` frame makes two bring-ups; the outgoing one must not tear
down its replacement). `preInitAudio`/`preInitDone` are context cleared by
entering `down`.

- **Cancellation does not close a mic the browser already granted**: `bringUp`
  checks its own `signal` after `open` settles and releases what it built. That
  is the only "still wanted?" check — do not add generation counters or flags
  back on `ConnState`.
- The machine touches no socket or snapshot; effects are
  `session-core-audio-effects.ts`, setup is `session-core-audio-setup.ts`, so
  `session-core-audio-state.test.ts` specs it without a browser.

### Drain completion outlives the turn

`done()` resolves when the worklet drains, which also happens when the
AudioContext stops — possibly after the turn or session is over. Two guards:

- **The turn epoch lives on `ConnState.turn`**, bumped by the audio path's
  `endTurn` effect on every committed user turn, barge-in, reset — and on
  entering `down`, since teardown is a turn boundary. Otherwise a late drain
  writes `"listening"` over `"disconnected"`/`"error"`.
- **The worklet's `stop` echoes its turn id** and `audio.ts` settles only the
  matching wait (details in `worklets/CLAUDE.md`).

The server side paces audio at a bounded lead (`aai/host/audio-pacer.ts`):
`CLIENT_AUDIO_LEAD_MS` **must stay above `PLAYBACK_JITTER_MS`**; `audio_done` is
queued BEHIND held audio; `cancelled`/`reset` DISCARD held audio.

### A handshake is not a session (`session-core-handshake.ts`)

An open socket proves only a `101`; the server sends `config` at zero RTT, and
partysocket's `connectionTimeout` stops at `open`. Without a guard a wedged peer
leaves the session on `"ready"` (painted as live) forever. `createHandshakeGuard`
arms per `open`, disarms on `config` or close, re-dials on expiry, and after
`MAX_HANDSHAKE_TIMEOUTS` surfaces a `connection` error.

- **Its budget is its own** — `reconnect()` resets partysocket's retry count, so
  `RECONNECT_OPTIONS.maxRetries` cannot bound this.
- **The budget is CONSECUTIVE**: `succeeded()` (a completed handshake) resets it;
  `disarm()` (a socket closing) must NOT, or a wedged peer re-dials forever.
- **The timer is a bare `setTimeout`**: disarm on `abort` explicitly, or a user
  disconnect gets re-dialled.

### Client config lookup (`client-config.ts`)

- **Every request the session makes needs its own deadline.** The lookup runs
  inside partysocket's URL provider, which arms no timeout until the URL
  resolves — a hung fetch means no socket, no retry, "connecting" forever.
  `CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS` (10 s) makes a hang degrade like a failure.
- **The session's per-attempt lookup uses `loadClientConfig`** (`null` = no
  answer), never `fetchClientConfig` (`{}`). Only an ANSWERED lookup with no
  `sessionUrl` may latch `serverIsBroker = false`; latching on a failure pins the
  client to `/:slug/websocket`, whose redirect browsers do not follow.
- **The session lookup re-brokers per ATTEMPT** so a reconnect reaches a
  replacement sandbox — never memoize it across the render-time lookup.
  `mountClient()`'s render lookup is skipped when `mountClient({ name })` is set
  (on the platform it is the broker and can boot a sandbox); a custom
  `component` ignores it.
- **`apiUrl` (shown by `ApiUrlChip`) is the long-lived platform endpoint**
  (`wss://host/:slug/websocket`), never the sandbox tunnel URL, which rots.
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
  (tool after its `afterMessageId` anchor; an orphan leads), the streaming bubble,
  the transcript row and the thinking-suppression rule. It subscribes per field.
- **`useSessionActions()`** is `useSessionCore` narrowed to the eight methods, no
  subscription. Pair it with one-field selectors, `useSessionStatus()` or
  `useSessionError()` — never whole `useSession()` in a chrome.
- **`useUserTranscript()`**: `null` is silence, `""` is speech with no words yet.
  Render on `speaking`; `text` carries the placeholder; `partial` is raw.
- **`useAgentState(projection)`** is the overload to use: typed and defaulted by
  the projection, memoized on its identity. Export the projection once from the
  module declaring the slot and import it in both `agent.ts` and `client.tsx`.
  The projection overload is declared FIRST (else `fallback: S` swallows it) and
  discriminated by `typeof === "function"` (wire JSON cannot be a function);
  `hooks.test-d.ts` pins all three signatures. Prefer the `fallback` overload
  only when the slot's `create()` is expensive to ship to the browser.
- **State or moment:** if re-rendering after a reload would be RIGHT, it is
  state → a `sessionSlot` read by `useAgentState`. If it would be a lie or a
  nuisance, it is a moment → `useEvent` / `useToolCallStart` (which never
  replays). `entertainment-picks-agent` shows both.
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
  (`session-resume-store.ts`). Do not wire `onSessionId`/`resumeSessionId` by
  hand, and never into `localStorage` (a stale id suppresses the greeting and
  rejoins a dead context).
- **`usePushToTalk`** drives `session.userTurn` (`start`/`commit`/`clear`) for a
  `turnDetection: "manual"` agent; its module doc lists the ways a hand-written
  button leaves a turn open.

## Fuzz harnesses

`fuzz-session-core` (frames × controls × socket lifecycle), `fuzz-voiceio`
(enqueue/done/flush/close × worklet stops), `fuzz-hooks` (exactly-once
tool-call/event delivery), `fuzz-reconnect` (broker latch, resume ids, history
replay); `worklets/audio-stress.test.ts` for the processors. They assert
INVARIANTS. Beyond "Property tests run on fast-check" (`.agents/testing.md`):

- **Check sensitivity** — revert the fix and confirm the harness fails. The audio
  mocks accumulate nodes across a test, so a harness can silently drive a DEAD
  worklet node.
- **Stay faithful to the protocol** — one `config` per connection, a drain-stop
  only after a `done`, timers advanced 1 ms per op — or the violations are the
  model's own.

## Workflow apps

A `page: "static"` agent (declared with `workflowApp({ name, workflows })` from
`@alexkroman1/aai`) is a web page over the workflow HTTP API: no session,
WebSocket or audio. The routes are served by `aai/host/workflow-api.ts`, whose
module doc is the authoritative table; the platform brokers them at
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
  resolution). `StaticAgentParams` types every non-static field as
  `WorkflowAppMisuse`; voice arms refuse `page: "static"` via
  `StaticFrontDoorMisuse`.
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
  `getWritable()`. Stream chunks are RETAINED, so a stream read is also a replay.
- `api.watch` / `api.streamOutput` return the raw `Response` because a 404 (an
  older agent) is a normal path this package's hooks fall back from;
  `follow`/`followOutput` are the SDK iterators (not used here). `readEventStream`
  is the one SSE parser — never add a second.
- **`wake`**: `woken: 0` is an answer, like `cancelled: false`.
- **`wait`** (`POST` body / `?wait=`): answers at terminal or budget expiry;
  expiry answers the RUNNING snapshot at 202, never an error.
  `clampWorkflowWait` (`MAX_WORKFLOW_WAIT_MS`, 60 s) applies at both ends. The
  server loop watches the RESPONSE, not the request (a read `IncomingMessage` is
  already `destroyed`), and answers an unknown id at once.
  `useWorkflowSubmit(workflow, { wait })` still follows with `useWorkflowRun`.
- **Auth is fail-open**: the surface is as public as `/websocket`;
  `AAI_WORKFLOW_API_TOKEN` makes every route require a bearer. So
  `<audio src>` / `<a href>` cannot point at an upload — use `api.download`
  → `Blob` → `useDownloadUrl`.
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
  `starting || tracked.polling` for this reason.
- **Every stream ending is named** (`done`, `missing`, `idle`); only `idle` hands
  back to the poll.
- `WorkflowOutputOf<typeof wf>` narrows `run.output` on `"completed"` via a
  type-only import of `agent.ts`.

### Progress (`useWorkflowProgress`)

Reports what the run WROTE (`useWorkflowRun` reports its state).

- **Reads are BOUNDED and re-opened**: a progress stream is never closed (no step
  knows it is last), so the route bounds each read by `streamTail()` and `done`
  carries `complete`; the hook re-opens from where it left off until `complete`.
  Only `dev-workflow.scenario.test.ts` can see a regression here.
- **`supported`** separates "deploy predates streams" (hide) from "nothing
  written yet" (wait). Dropped reads and thrown fetches are retried.
- **Chunks replay from index 0 by default.** A negative `startIndex` is resolved
  on the FIRST read (issued from 0, trimmed); later reads are absolute.
- **One React commit per read, not per chunk.**
- `_repeat-until.ts` is the bounded-read loop; `_workflow-api-ref.ts` the ref
  preamble.
- Write side (every `step*` helper here is on `@alexkroman1/aai/step`):
  `stepReport(line)` writes to the stream
  AND the server log with `(attempt N)`; `stepEmit(namespace, chunk)` writes
  structured values to a REQUIRED named stream (never the default one — a page
  renders it as text), not logged. Both from a STEP only (a body replays), both
  best-effort; `stubReporter()` asserts them in specs. Steps should also use
  `isTransientStatus(status)` and `retryAfter(response)` from `/step` rather
  than hand-rolling a 408/429/5xx split or ignoring `Retry-After`.

### Submitting (`use-workflow-form.ts`, `use-workflow-stream.ts`)

- **`useWorkflowSubmit`**: `pending` covers the RUN, not the POST; drop the
  previous run id BEFORE the next request. Returns `wake()`/`cancel()` bound to
  its run (`_run-controls.ts`, shared because `WorkflowStreamSubmission` aliases
  `WorkflowSubmission`); both answer (`0`/`false`) when there is no run.
  `reset()` puts the FORM back and leaves the run running.
- **Files**: every `File` in the values is stored via `api.uploadStream()` under
  an id the hook MINTS (so an interrupted upload can resume), then the id is
  substituted and the run started. `WorkflowSubmission.upload` reports bytes and
  drops on the last byte. Byte progress uses `XMLHttpRequest` where available
  (`fetch` cannot observe a request body) — the SDK owns that swap.
- **`useWorkflowStream`**: same surface, but the run starts BEFORE the upload
  finishes (`PUT` under a minted id; the store exposes a growing `size`). It puts
  the id where `uploads` says, WAKES the run when the upload lands, and CANCELS
  the run if the upload fails. Nothing here knows the file is audio.
- **Parallel parts by default** (`parallel: { partBytes, concurrency } | false`).
  The store's `size` is the contiguous prefix; outage resume is the SDK's
  (`aai/sdk/_upload-resume.ts`); a form's files stay sequential; it degrades to
  one request for small files or older agents.
- **Pause/resume** (`pauseUpload`/`resumeUpload`, `UploadStatus.paused`) is an
  abort plus the minted id — no new storage. `submit()` stays unresolved
  across a pause; the run is untouched (its idle bound applies); `reset()`
  ABANDONS with no error. `_upload-session.ts` keys off the ABORT, not
  `gate.paused` (a double-click reopens the gate before the rejection lands).

### Reload recovery

- **Upload recall** (`_upload-recall.ts`, `sessionStorage`): keyed on a
  FINGERPRINT (size, lastModified, type, name) and written BEFORE the first byte.
  A recalled id is a candidate: `claimId` (`_upload-files.ts`) reads `uploadInfo`
  first — complete → skip the transfer; unfinished WITH windows → resume
  (`resume: true`); anything else, including unfinished with NO windows (a
  second `PUT` gets 409) → fresh id. Specs that want a second transfer need a
  second file and clear `sessionStorage` between specs.
  `useWorkflowStream` does NOT recall (it would start a second run on the first
  run's upload).
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
