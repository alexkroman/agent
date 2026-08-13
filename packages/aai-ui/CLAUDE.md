# packages/aai-ui — browser client guide

The browser client (`@alexkroman1/aai-ui`): session, audio, React UI. Repo-wide
conventions and testing rules live in the root `CLAUDE.md`.

## Package exports

- `.` — default React UI component + session + client helpers
- `./styles.css` — default styles
- `./default-client/*` — prebuilt default client assets (`dist/default-client/`)
- `./client-dir` — **Node only**: `defaultClientDir()`, the filesystem path of
  those assets, for passing to `createServer`/`createAgentServer` as
  `clientDir`. Its own subpath because it imports `node:module`/`node:path`,
  which must never reach the browser barrel. It is a FUNCTION, not a constant:
  resolution throws when the package is missing, and a module-level constant
  would move that failure to import time, firing for callers that never wanted
  the client. `aai-cli`'s dev server and every self-hosted example used to
  carry their own copy of the three-line resolve.

## The authoring surface is versioned in epochs

**This package's exports are authored code, and they are contracted the same way
the SDK's are.** The mechanism, the classification workflow (`--retain` /
`--drop`), and why an epoch obliges a frozen compiling example all live in the
root guide's "The authoring surface is versioned in epochs"; what is local to
here is the naming. `contracts/entrypoints/` declares **nine capabilities**, and
between them they must name every `@public` export of `.` and `/client-dir` — a
new one fails `pnpm check:api-contracts` until it joins one:

| Capability | What it promises |
| --- | --- |
| `client` | the voice mount — `client()`, its two config tiers, the handle |
| `page` | the workflow-app mount — `page()`, with no session under it |
| `session` | the live call: `SessionCore`, the snapshot, `useSession`, the errors, `VOICE_CAPTURE_CONSTRAINTS` |
| `hooks` | what a client reads off the AGENT: `useAgentState`, the two tool hooks, `useEvent` |
| `components` | the design system a custom chrome is assembled from |
| `forms` | `<Form>`, the field components, `<WorkflowFields>` |
| `workflow` | `createWorkflowApi`, `useWorkflowRun`, `useWorkflowSubmit`, `useWorkflows` |
| `theme` | `ClientTheme` + `useTheme` — its own contract because a token is a name in somebody's CSS |
| `client-dir` | `defaultClientDir()`, the one export a SERVER calls |

Three things to know before touching them.

**A capability id is qualified — `aai-ui:forms`, not `forms`.** `workflow` names
a capability of both packages (the SDK declares a workflow, this reaches one over
HTTP) and they version independently, so the CLI refuses a bare ambiguous name
rather than guessing.

**The compatibility fixtures are `.tsx`, and they are the reason to write them
carefully.** A frozen example for a component library is JSX or it is not
evidence — and `pnpm typecheck` is what runs them, so a break in this package's
types surfaces as a compile error inside
`contracts/compatibility/<capability>/v<N>.tsx` naming the epoch it broke. Two
findings came straight out of writing the first set: `WorkflowApiOptions.token`
cannot take an explicit `undefined` under `exactOptionalPropertyTypes`, and
`api.get` is deliberately untyped (`useWorkflowRun<R>` is where a page names the
shape).

**The `@internal` ratchet here stands at nine**, all on the root barrel and all
recorded in `contracts/internal-surface.json`: `SessionProvider`,
`ThemeProvider`, `ToolConfigContext`, the three URL chips (`ApiUrlChip`,
`UiUrlChip`, `SessionUrlChips`), and the client-config trio (`buildAgentUrl`,
`fetchClientConfig`, `loadClientConfig`). Every one is importable and in an
author's autocomplete while no contract covers it — `client()` and the default
client install them, which is why they are tagged rather than moved. The list may
shrink and may never grow; unlike `aai` there is no `/internal` subpath to move
one to, so paying it down means a private module.

## Key files

- `index.ts` — main exports, React UI component
- `session-core.ts` — WebSocket session management + reactive snapshot
  (`createSessionCore`); split across `session-core-messages.ts`
  (message/history handling) and `session-core-types.ts`
- `context.ts` — SessionProvider, useSession, useSessionCore,
  useSessionSelector, ThemeProvider, useTheme
- `hooks.ts` — useToolResult, useToolCallStart, useEvent
- `audio.ts` — PCM encoding/decoding, AudioWorklet management
- `define-client.tsx` — client mount helper
- `default-client.tsx` / `build-default-client.ts` — the default UI shipped
  to agents with no `client.tsx`, and its build step
- `types.ts` — UI type definitions
- `components/` — UI components (console-shell, chat-view, controls,
  message-list, auto-scroll, start-screen, sidebar-layout, tool-call-block,
  button, aai-logo, tool-config-context)

## `AutoScroll` is the only scroll-pinning implementation

`components/auto-scroll.tsx` wraps `use-stick-to-bottom` (pin to the bottom as
content grows, release when the reader scrolls up, re-engage at the bottom).
`MessageList` renders it rather than the library directly, so there is one
owner, and it is EXPORTED because the clients that need it most are the ones
not using `MessageList` — a custom chat chrome (a terminal, a dispatch board)
that would otherwise hand-roll the effect.

The hand-rolled version is a `useEffect` calling
`ref.current?.scrollIntoView()` keyed on `session.messages`, and it fails three
ways that compound: it fights the reader, since scrolling up to re-read is
undone by the next transcript delta; it misses growth that is not a new message
(a streamed reply, an expanding tool block, a markdown reflow all change height
without changing the dependency array); and it needs a synthetic dependency
(`messages.length + transcript.length`) to fire at all, which is where the dead
`if (version < 0) return;` line in `infocom-adventure`'s copy came from. A
`ResizeObserver` on the content has none of those.

The one constraint callers get wrong: the outer container **must have a bounded
height** (`flex-1 min-h-0`, `h-full`, a fixed height). An unbounded one grows
with its content and never scrolls, so nothing pins.

## `useAgentState` has a fallback overload

`useAgentState<S>()` returns `S | null` — nullable because nothing has been
pushed before the first tool call. `useAgentState<S>(fallback)` returns `S`.
Every real consumer wanted the second: four of the six template clients
immediately wrote `?? EMPTY`, and three of those built `EMPTY` by running their
own `syncState` projection over an empty state, which is the pattern to copy —
`slot.projection(view)(undefined)`, so a field added to the projection reaches
the first render instead of being `undefined` in that one frame. Hoist the
fallback to module scope; the hook does not memoize it.

Note the fallback is only substituted for `null`, and an absent argument still
reads back as `null` rather than `undefined` — a client spelling
`state === null` predates the overload. `hooks.test-d.ts` pins both signatures,
since an overload is a type-level contract a runtime suite cannot assert.

## Client audio path (browser ⇄ server)

Both legs carry **raw PCM16 over the session WebSocket** — 384 kbps down at
24 kHz, 256 kbps up at 16 kHz, uncompressed, with the mic streaming
continuously (barge-in needs it open). That budget is the backdrop for
everything below: a jitter buffer absorbs *jitter*, and no size of buffer
fixes a link that cannot carry the bitrate in real time.

**Playback is a jitter buffer with hysteresis, not a startup delay**
(`aai-ui/worklets/playback-processor.ts`). It fills to `PLAYBACK_JITTER_MS`
before a turn speaks, and on an underrun it returns to filling — to the
shorter `PLAYBACK_REFILL_MS`, because mid-reply a long wait is itself a hole
in the speech. The re-arm is the whole point: while the gate only guarded the
*start* of a turn, one stall left `readPos` chasing `writePos` and every later
quantum emitted a few real samples padded with silence, so a single network
hiccup turned the rest of the reply into ~5ms fragments — stutter through
every word rather than one pause. A starved quantum never advances `readPos`,
so buffered audio survives intact.

Gaps are **concealed**, not zero-filled: the worklet loops the retained tail
of played audio under a decay to silence (`PLAYBACK_CONCEAL_FADE_MS`). A hard
zero-fill is a discontinuity mid-word, which is what makes a brief stall sound
like breakage rather than a pause.

**Underruns are reported, in WebRTC's counter shape.** Each turn's `stop`
message carries `concealedSamples`, `silentConcealedSamples` (a subset, as in
`getStats()`), `concealmentEvents`, and `silentConcealmentEvents`, surfaced as
`VoiceIOOptions.onPlaybackStats` (the default session leaves it unwired). Nothing
else marks an underrun — the session still reports `"speaking"` and `done()`
still settles — so this is the only way to tell a turn that needed its cushion
from one that didn't, and the only honest basis for retuning
`PLAYBACK_JITTER_MS`. A high `silentConcealedSamples` share means the stall
outran what concealment can cover, i.e. a bandwidth problem rather than a
tuning one.

**A turn's drain completion is guarded twice, because the drain outlives the
turn.** `done()` resolves when the worklet drains — which also happens the
moment the AudioContext stops rendering — so a reply's completion can land
long after the turn, or the whole session, is over. Both guards were added
after the fuzz harnesses (`aai-ui/fuzz-*.test.ts`) caught the two failures:

- **The turn epoch lives on `ConnState.turn`, not in the message handlers**,
  and `cleanupAudio()` bumps it alongside every committed user turn /
  barge-in / reset. Teardown is a turn boundary: hanging up mid-reply,
  a fatal error, or a reconnect closes the context, the pending
  `settleWhenAudioDrained` continuation resolves a second later, and without
  the bump it wrote `state: "listening"` over the session's own
  "disconnected"/"error" — a dead session claiming a live mic in the header.
- **The worklet's `stop` carries the turn id its `done` named**
  (`playback-processor.ts` echoes it; `audio.ts` only settles the wait whose
  id matches). Dropping `reason: "interrupt"` stops is not enough: a REAL
  drain-stop already in flight when a barge-in flushes is a legitimate stop
  for a turn the host has moved past, and settling on it reported the next
  reply finished while it was still speaking.

**The server paces audio out at a bounded lead** (`aai/host/audio-pacer.ts`,
wired into `ws-handler.ts`'s `ClientSink`). TTS outruns playback, so relaying
each provider frame on arrival put a whole reply into the socket buffer at
once; on a slow link that is seconds of queue the server cannot see into,
bounded only by the `MAX_CLIENT_WS_BUFFERED_BYTES` disconnect.
`CLIENT_AUDIO_LEAD_MS` **must stay above `PLAYBACK_JITTER_MS`** — the lead is
the client's only source of cushion, so pacing at exactly real time would
leave the playback buffer unable to fill. Holding audio back makes two
orderings load-bearing, both enforced by the pacer:

- `audio_done` is queued **behind** pending audio. It is a turn boundary; the
  worklet takes it as "this is all there is", so an early one truncates the
  reply.
- A `cancelled`/`reset` event **discards** held audio. The client flushes its
  own buffer on those events, so anything still held would arrive afterwards
  and play as an orphan fragment.

**Capture runs on its own AudioContext at the STT rate**, and the worklet
converts no rates (`aai-ui/worklets/capture-processor.ts`). The browser's
resampler is band-limited; the linear interpolation this replaced folded
everything above the new Nyquist back into the band as aliasing. Playback
keeps a separate context at the TTS rate, and the two collapse into one when
the rates match. There is deliberately **no fallback resampler**: `audio.ts`
asserts the browser honored both requested rates and fails init otherwise,
because a context at another rate either ships audio to a socket that declared
a different rate or plays PCM at the wrong speed — a loud failure beats
either.

**Capture is raw voice, echo cancellation aside.** Both `getUserMedia`
call sites (the WebSocket mic and `createPttRecorder`) share one exported
`VOICE_CAPTURE_CONSTRAINTS`, because copies of the object drifted apart
trivially. `autoGainControl`, `noiseSuppression`, and `voiceIsolation` are all
**off**: each rewrites the signal before STT sees
it — AGC continuously retargets level, so it rides the noise floor up through
silence, while
suppression and isolation discard signal and can gate a quiet room to *exact*
zeros, which is also what a dead mic looks like. `echoCancellation` stays on:
the mic is open while the agent speaks (barge-in needs it), so without AEC the
agent hears itself and interrupts its own reply.

**A dead microphone is detected once per session.** An OS-muted or wrong input
device delivers digital silence, which from every other vantage point is
identical to a user who has not spoken: socket up, session listening, no turn
ever committed. The capture worklet watches the first `MIC_SILENCE_PROBE_MS`
for any nonzero sample (a live mic in a quiet room still carries a noise
floor) and reports once via `VoiceIOOptions.onMicSilent`. It disarms on the
first real sample, so it costs nothing after the window and cannot fire
mid-session.

## Workflow apps

An agent's front door is a microphone or a form, and `AgentDef.page` is the
declaration. `"voice"` (the default; absent means this everywhere) is the whole
product so far. `"static"` declares a **workflow app**: an ordinary web page
over the workflow HTTP API, with no session, no WebSocket and no audio.

This section covers the surface end to end because the author-facing half is
here — `page()`, `createWorkflowApi()`, `useWorkflowRun()` — and
`packages/aai/CLAUDE.md` is at its size cap. The routes themselves are served by
`aai/host/workflow-api.ts`, whose module doc is the authoritative table.

### `workflowApp()` is the server-side half of the same split

An author declares one with `workflowApp({ name, workflows })`
(`@alexkroman1/aai`), not with `agent({ …, page: "static" })`. It returns the
same `AgentDef` — one definition type, one config, one deploy path, and `page`
stays a statement about the front door — so this is an authoring seam, never a
second runtime shape.

**The parameter type is what earns it.** `AgentParams` grew a fourth arm,
`StaticAgentParams`, keyed on the front door rather than on a session mode; it
accepts `name`, `greeting`, `workflows` (REQUIRED — an app whose whole API is
`/workflows/*` and which declares none serves a form that 400s on every submit)
and `requiredEnv`, and types every other field as a `WorkflowAppMisuse` message.
That list is derived from `ProviderField` and `PipelineOnlyField`, so a new
provider stage or voice knob is refused here without anyone remembering to add
it.

**Both halves are load-bearing.** The three voice arms had to start refusing
`page: "static"` from their side (`StaticFrontDoorMisuse`), because an arm every
other arm also matches never bites: with `page` left on `SharedAgentParams`,
`agent({ voice: "michael", page: "static" })` resolved against
`PipelineAgentParams` and configured a TTS voice for an app that never speaks.

**The cost of not having this was already shipped.** `link-digest` carried
`systemPrompt: "Summarize links into three honest points."` — instructions to a
model that never runs, since a static agent has no session and no LLM loop, and
a `"use step"` body calls whatever model client it imports itself. The comment
above it claimed `GET /client-config` served it; that endpoint serves `name`,
`greeting` and `page`, and has never carried a system prompt. Both workflow-app
templates are now three lines and every one of them does something.

`greeting` survives as declarable because it is the one client-config field a
workflow app can still use — but note `page()` does not fetch the endpoint the
way `client()` does, so a page that wants `name`/`greeting` from the agent calls
`fetchClientConfig()` itself rather than receiving them.

### `page()` is a second mount, not a flag on `client()`

`client()` unavoidably constructs a `SessionCore`, which owns a WebSocket URL
provider, an audio graph and a microphone request. A flag would have to make all
of that conditional, and every session hook would then have to answer "what does
this mean with no session?" — so the honest split is two mounts. Authoring is
otherwise identical: still `client.tsx`, still React, still Tailwind, still the
same theme tokens. `template-page-mount.test.ts` (in aai-templates) correlates
the two, asserting every template's mount matches what its own `agent.ts`
declares — konsistent cannot express "one of two imports", and a rule that
merely accepted either would pass the mistake worth catching.

**The declaration is not decoration on the server side either.** `createServer`
declines `/websocket` for a static agent — COMPLETED and then closed with a
protocol error naming the reason, rather than dropped, because a bare socket
drop leaves a client reconnecting against a server that will never answer — and
telephony defaults OFF, since an agent with no `stt`/`llm`/`tts` has nothing to
put on a call. It is reported in `GET /client-config` so a browser knows before
it dials, and `aai dev` and the deployed guest honour it identically: a page
mounted with `client()` by mistake fails locally, not after a deploy.

**A workflow app therefore needs NO provider credential, and two places had to
learn that separately.** An agent declaring no `stt`/`llm`/`tts` gets the
all-AssemblyAI pipeline injected (`defaultProviders`), which for a voice agent
is the whole point and for a page is a credential nothing will ever dial — so
`requiredProviderEnvVars` returns `[]` for `page: "static"` (the preflights: it
had `aai dev` reaching for the logged-in key and dying `not_logged_in`, and the
deploy preflight demanding a key the agent does not use), and `createRuntime`
DEFERS resolving those providers instead of doing it at construction (the
runtime: `resolveLlm` throws on a missing key, so a workflow app could not boot
at all — under `aai dev` it never started, and deployed it is a 500 on the
workflow API of an app whose workflows are fine, which is the case
`workflow-api.ts`'s `engine` doc names). Both templates ship exactly this shape,
so `aai init -t link-digest && aai dev` is the reproduction.

The check keys off `page` rather than the descriptors because by the time a
config reaches the deploy preflight the injection has already happened: "declared
nothing" and "declared the default" are the same object there. Deferring rather
than skipping keeps the honest error for the one path that can still open a
session on a static agent — an embedder passing `createServer({ telephony: true
})` — which resolves at session start and reports the missing key by name.

### The API is `ctx.workflows` spelled over HTTP, and nothing more

```text
GET    /workflows                 → { workflows: WorkflowSummary[] }
POST   /workflows/runs            → { runId }   body: { workflow, input?, key? }
GET    /workflows/runs            → { runs }    ?workflow=&key=&limit=
GET    /workflows/runs/:id        → a WorkflowRunSnapshot
DELETE /workflows/runs/:id        → { runId, cancelled }
GET    /workflows/runs/:id/events → SSE: run | done | missing | idle
```

`ctx.workflows.start()` only covers the case where a VOICE TURN starts a run; a
page and a programmatic caller (`aai workflow`, a script, a cron job) had no
surface at all. Mounted on `createServer`, so `aai dev`, a self-hosted server
and every deployed agent serve it identically — the same reasoning `/phone` is
mounted there rather than bolted onto the platform. On the platform the page's
calls land on `/:slug/workflows/*` and are brokered (`aai-server/
workflow-handler.ts`), because `createWorkflowApi` builds every URL from
`location` and has no broker step of the kind the voice session gets.

**Every route is one `WorkflowClient` call, and the type says so**: the API's
engine IS `WorkflowClient`, not a wider "engine" with run-store reads of its
own. That width is what would let route code drift into the journal, which
belongs to the Workflow DevKit — so a route needing more than a tool can do is
the signal to add a client method, never to widen this. Hence what is
deliberately absent: no `/blobs` (bytes belong behind a URL or in the app's own
storage, fetched inside a `"use step"` function where they are read once per
execution rather than on every replay), no `/signals/:token` (a waitpoint is
`createWebhook()`'s, and the platform already proxies its URL), and no `/retry`
(resuming a terminal run is the WDK's business, and a route would have to invent
what "again" means).

**The surface is as public as `/websocket` beside it.** A page carries no
credential — it is served to anyone with the URL, exactly like the voice client
— so requiring one by default would mean no static page could ever work. What is
genuinely worse here is the COST SHAPE: a run outlives the request that started
it, so a loop of cheap POSTs queues far more work than a loop of voice sessions.
An operator who wants it closed sets `AAI_WORKFLOW_API_TOKEN` in the agent env
and every route requires it as a bearer; the platform forwards the header, and
`aai workflow --token` and the studio's runs card present it. Fail-OPEN when
unset is the documented default, and the platform's per-IP limits
(`WORKFLOW_IP_RATE_LIMIT`, and a much tighter one on `POST /runs`) are what bound
the cost in the meantime.

### Two vocabularies use the word "name", and mixing them is silent

A WDK run record's `workflowName` is the COMPILER's identifier —
`workflow//./workflows/digest//digestFlow`, the same string as `workflowId`,
which the DevKit's own docs call machine-readable and hand to
`parseWorkflowName()` before showing anyone. Ours is the key in
`agent({ workflows })`, which is what `WorkflowRunBase.workflow` promises.
`workflow-client.ts` translates in both directions, and both were once missing:
the keyless read (`GET /workflows/runs` with no `key`, i.e. `ctx.workflows
.recent`) filtered by the DECLARED name, which matches no stored run, so it
answered `[]` for every workflow and `aai workflow runs <name>` printed "No runs
of X yet" for every agent — while every snapshot reported the machine id as its
`workflow`, which `research-desk`'s status tool reads down the phone. `find` was
unaffected: it goes through our own key index, which is keyed by declared name.

Neither could be caught by a stub, which is the reusable part: a fake adapter
answers with whatever name the test wrote, so `workflow-client.test.ts`'s fake
now stores runs under the compiler id and filters by it.

### Watching a run

`useWorkflowRun(runId)` tries the event stream first and falls back to polling.
The poll is the honest DEFAULT — a run outlives the page, so re-reading the id
is the simplest correct implementation — and the stream is an optimisation over
it, because on the platform every polled read BROKERS: N open tabs at
`DEFAULT_WORKFLOW_POLL_MS` (2 s) is N/2 brokered requests a second, each able to
boot a sandbox. So every way the stream can fail — an older agent with no
`/events` route, a proxy that buffers, a dropped connection — degrades to the
thing that works, and `watchRunEvents` calls back exactly once when it does.

`EventSource` is not used, for two reasons that both bite: it cannot send an
`Authorization` header (an agent with a token would be unreachable) and it
reconnects on its own schedule, which would fight the caller's.

Four properties are load-bearing and each covers a bug that is silent:

- **The client is held in a REF, not named as an effect dependency.** The
  natural spelling passes a new object every render; as a dependency that is an
  unbounded request loop against the agent, with `error` wiped before anything
  can read it — presenting as "the page polls forever" rather than as a mistake
  at the call site. Hoist the client out of the component anyway.
- **A 404 is a STABLE answer**, so the poll gives up after `MAX_MISSING_READS`.
  Unbounded, a stale id (restored from `localStorage`, or belonging to an agent
  redeployed onto a fresh database) polls — and BROKERS — for as long as the tab
  is open.
- **`polling` cannot be derived from the snapshot alone.** Giving up on a
  missing id leaves `run` undefined, which reads as "still waiting", so the
  hook tracks the stop explicitly.
- **Every stream ending is NAMED** — `done` (terminal), `missing` (will never
  exist), `idle` (the stream hit its own duration cap, because a run can sleep
  for hours and a connection held that long is one nothing is maintaining). A
  client can tell "finished" from "dropped" without guessing, and only `idle`
  hands back to the poll.

`WorkflowOutputOf<typeof myWorkflow>` is what makes `run.status === "completed"`
narrow to a TYPED `run.output`: a type-only import of `agent.ts` is erased, so
naming the agent's own type pulls no server graph into the browser bundle.
`link-digest` in `packages/aai-templates/templates/` is the worked example.

### One request in, one result out (`wait`)

Both read paths take a wait budget — `POST /workflows/runs` from the body,
`GET /workflows/runs/:id` from `?wait=` — and answer when the run reaches a
terminal status or when the budget expires, whichever is first. The loop is
`aai/host/workflow-api-wait.ts`; on the client it is `api.startAndWait(workflow,
input, { wait })` and `api.get(runId, { wait })`.

The asynchronous shape stays the DEFAULT, because it is the honest one: a run is
durable and deliberately unfinished when the request returns, and a page has
`useWorkflowRun` to watch with. What had no surface at all is everything else
that talks to an agent — a shell script, a cron job, another service, a form
whose only job is to show an answer — each of which otherwise writes the same
poll loop against `GET /runs/:id`. So `wait` is additive and nothing changes
without it: a bare `POST` still answers `{ runId }` at 202, and with a wait it
adds `run` beside the same `runId`.

Four properties, each covering something that is silent when it goes wrong:

- **Giving up is an ANSWER.** An expired budget answers the RUNNING snapshot at
  202 — never an error, never a cancel. The run is real and the caller holds its
  id, so a 5xx would throw away the one thing they cannot rebuild. That is what
  makes the cap safe to ENFORCE rather than a trap: `clampWorkflowWait`
  (`aai/sdk/workflow-run.ts`, `MAX_WORKFLOW_WAIT_MS` = 60 s) is applied at both
  ends, so a client cannot ask an agent to hold a socket longer than the agent
  will, and asking degrades to the behaviour that was already there.
- **The loop watches the RESPONSE, not the request** (`CallerLink`). An
  `IncomingMessage` is `destroyed` as soon as its body has been read — already
  true on a `POST` by the time the wait starts — so a loop watching the request
  reads "the caller gave up" on its first pass and answers 202 immediately. The
  status is legal and the run really is still going, so nothing about that
  failure is visible.
- **An unknown id answers at once**, after one read. A 404 is a stable answer,
  and spending a 60 s budget on one is how a stale id from a previous deploy
  holds a request open for a minute.
- **It polls, and that is the cheap kind.** The loop runs INSIDE the guest, next
  to the world the run lives in, for the life of one request the caller is
  already holding open — no HTTP hop and no brokering per read, which is what
  makes the SSE stream's interval expensive by comparison. Hence
  `WORKFLOW_WAIT_POLL_MS` (250) being quicker than `RUN_EVENT_POLL_MS`: a
  synchronous call's whole value is that a fast run answers fast.

`useWorkflowSubmit(workflow, { wait })` opts a form in, and still follows the
returned id with `useWorkflowRun` afterwards — the budget bounds the request, not
the run.

### Forms (`components/form.tsx`)

A workflow app's front door is a form, and nothing in this package knew how to
render one — every component here is about a live session (a transcript, a mic
button, a tool-call row) — so each such page hand-rolled labels, inputs, a submit
button and the value collection between them, differently each time.
`<Form>` plus `Field` / `TextField` / `NumberField` / `TextAreaField` /
`SelectField` / `CheckboxField` / `FileField` / `SubmitButton` is that, once.

**Values come off the DOM, not out of React state.** `<Form>` reads its own
`<form>` element on submit and builds one plain object from the named controls,
which is what makes a field here nothing more than a styled `<input>` — no
registration, no controlled-component ceremony, and a bare `<input name="x">` a
caller writes themselves works identically. It also makes the values TYPED,
which `new FormData(form)` cannot: a number field yields a number, a checkbox a
boolean, an empty optional field nothing at all. That is load-bearing rather
than tidy, because these values go straight into a workflow's input where a zod
schema is waiting — `"3"` against `z.number()` is a rejected run, and the browser
is the only place that still knows the control was `type="number"`.

**A `<FileField>` describes a file; by default it does not upload one.** It
contributes `{ name, size, type, lastModified }`, and `read="text"` /
`read="dataUrl"` adds `content` for the cases where the bytes really are small.
A workflow's input is serialized into the run record and replayed from it on
every resume, so bytes in there are re-read for the life of the run and capped by
the request-body limit besides; a URL or the app's own storage is where they
belong, fetched inside a `"use step"` function that runs once per execution.

**`<WorkflowFields workflow="transcribe">` renders the schema half.** It takes
either the workflow's NAME — fetching the listing itself, which is the form a
page normally wants because the alternative is three lines (`useWorkflows()`, a
`.find()` by name, and folding that lookup's error into the form's) whose only
product is this component's argument — or a `WorkflowSummary` the caller already
holds, which fetches nothing (`useWorkflows({ skip: true })`, since the hook
cannot be conditional). It reads the summary that `GET /workflows` serves and
emits one control per
SCALAR property — string, number, integer, boolean, and an enum as a
`<SelectField>` — honouring `required`, `default`, and `description` as the hint,
with the label humanized from the property name (`recordingId` → `Recording
id`). It SKIPS objects and arrays deliberately: there is no honest control for
either, and rendering an approximation would be worse than leaving the field to
the caller, who writes it by hand in the same `<Form>` because every field is a
plain named control. So a form is half declared and half written, and adding a
scalar to the workflow's input schema adds a control with no client edit.

`useWorkflows()` fetches that list (the client held in a ref, read once — same
rule as `useWorkflowRun`) for a page rendering its own chrome from it; no
template exercises it any more, and the allowlist records that.
`useWorkflowSubmit(workflow, options?)` is
`api.start` plus `useWorkflowRun` plus the four pieces of state between them.
Two things it decides that a call site keeps getting wrong: `pending` covers the
RUN, not the POST — a button that re-enabled on the response invites a second
submission of work already in flight — and the previous run id is dropped BEFORE
the next request rather than when it returns, since a finished result sitting
under a form that is already submitting again is the one wrong answer this can
give, and it looks like a correct one.

`transcription-desk` in `packages/aai-templates/templates/` is the worked
example; `link-digest` is the smaller one and shows the primitives raw
(`createWorkflowApi`, `useWorkflowRun`, a hand-written `<form>`), which is worth
keeping as the thing these hooks compress.

## Surviving a platform restart (`client-config.ts`)

**Every request the session makes needs a deadline of its own, because a
hang is not a failure.** A request issued while the platform is restarting or
saturated can hang rather than fail — the proxy holds the socket open — and a
browser fetch has no timeout of its own, so the promise simply never settles.
Every *failure* path in `loadClientConfig` was already handled (`null`, then
the same-origin fallback); a hang reached none of them.

That is unrecoverable rather than merely slow, and the reason is the call
site: the lookup runs inside the session's WebSocket **URL provider**
(`currentWsUrl`, re-evaluated per attempt so reconnects land on the
replacement sandbox). partysocket awaits that provider under `_connectLock`
and arms its own `connectionTimeout` only AFTER the URL resolves — so a hung
lookup means no socket is ever constructed, no `error`/`close` ever fires,
and none of the 10 reconnect attempts ever happen. Measured with a hung
`client-config`: **zero sockets opened**, session pinned on "connecting"
forever, staying there long after the server came back. Nothing downstream
can time it out, and the state it wedges in is the one that looks healthy.

So `CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS` (10s — the same figure the studio's
gating reads use for the identical hazard) makes a timed-out attempt degrade
exactly like every other failed one: `null`, so `serverIsBroker` stays
unlatched (see `loadClientConfig`'s doc for why latching on a failure is its
own bug) and the attempt falls through to the same-origin `websocket` path,
whose failure re-enters the normal backoff and re-fetches on the next
attempt. `fetchClientConfig` inherits it, which also keeps a hung lookup off
the default client's pre-connection name/greeting render.

## A FATAL error must survive the frames that follow it

**A live socket is not a live session, and every fatal path EMITS on its way
down.** `SessionCore` had two independent rules that both read a later frame
as evidence the failure had been survived: `clearRecoveredError` recovered an
errored session to `listening` on any non-error event, and `reply_done` /
`cancelled` / `reset` each wrote `state: "listening"` unconditionally. The
host's fatal paths all call `terminate()`, and terminating calls
`onCancelled()` — so the frame ANNOUNCING the session's death was also the
frame that wiped the message explaining it, a few hundred milliseconds after
it appeared, leaving a session that looked live and was deaf.

The error that costs most is the one that names the fix: a missing provider
key surfaces as `Cartesia TTS: missing API key. Set CARTESIA_API_KEY in the
agent env.` (`requireApiKey`, `aai/host/providers/_utils.ts`) — reported by
`onProviderError`, which is fatal precisely because it terminates.

So `ConnState.fatalError` latches on the fatal branch of `handleErrorEvent`,
`clearRecoveredError` returns early while it is set, and the three turn
boundaries go through `toListening`, which drops the state field when it is
set (the `reset` case additionally keeps its `error`, since
`CLEARED_SESSION_STATE` nulls it). **Exactly one thing clears it: the next
`config` frame.** That is a completed handshake, i.e. a live session — the
one frame a dying session cannot produce, and per CONNECTION rather than per
session, so partysocket's automatic retries reaching a healthy peer are not
pinned to the dead one's banner. A NON-fatal error (`fatal: false`) is
untouched by all of this: the server said the session survived, so later
activity still retires its banner, which is the case the recovery was
written for.

## A handshake is not a session (`session-core-handshake.ts`)

**An open socket proves the peer answered `101`, nothing more.** The server
builds the session synchronously from its own upgrade callback and sends
`config` at zero RTT, so a socket that has been open for seconds carrying
nothing is not slow — its peer is not a healthy agent server. A tunnel or
proxy answering the `101` while the guest behind it is wedged looks exactly
like this, as does a host that dies between accepting and building the
session.

Nothing else catches it. partysocket's `connectionTimeout` covers only the
handshake and is cleared the instant `open` fires. So the session went to
`state: "ready"` — which `console-shell.tsx` paints with the SAME live
indicator as "listening" — and **stayed there permanently**: no `config`
means `initAudioCapture` never runs, so there is no mic, no error, no retry,
and nothing on screen to say so. Driven against a server that accepts and
then says nothing: `ready` at 34ms, still `ready` and errorless when the
probe gave up. A dead session that looks connected is worse than a visibly
failed one.

`createHandshakeGuard` arms a deadline on every `open` (re-armed per attempt,
since `open` fires again on each partysocket retry) and disarms it on the
`config` frame or the close. On expiry it re-dials — the sandbox behind the
endpoint may have been replaced, and the URL provider re-brokers — and after
`MAX_HANDSHAKE_TIMEOUTS` it surfaces a real `connection` error. Two things
make it correct rather than merely present:

- **The budget is its own.** `forceReconnect` calls partysocket's
  `reconnect()`, which resets `_retryCount` to -1 — so `RECONNECT_OPTIONS.
  maxRetries` cannot bound this failure mode, and without a separate cap a
  wedged peer would be re-dialed every ~10s forever.
- **The timer is a bare `setTimeout`, so it does NOT come off with the
  connection's `AbortSignal`** the way the socket listeners do. It has to
  disarm on `abort` explicitly, or an explicit disconnect leaves it armed and
  it re-dials a session the user already closed — caught by the existing
  "user disconnect does not reconnect" spec.

## Fuzz harnesses

`packages/aai-ui/fuzz-*.test.ts` drive the browser session's four
concurrency-bearing layers with generated operation sequences and assert
INVARIANTS rather than scenarios — `fuzz-session-core` (server frames ×
client control calls × socket lifecycle: snapshot monotonicity, caps, and
quiescence after teardown), `fuzz-voiceio` (enqueue/done/flush/close ×
worklet stops: every `done()` settles, and only for its own turn),
`fuzz-hooks` (commit batches: exactly-once tool-call/event delivery through
the watermark cursor), `fuzz-reconnect` (partysocket + a fuzzed
`client-config`: the broker latch, resume ids, history replay). The
worklet processors have their own equivalent in
`worklets/audio-stress.test.ts`.

Two properties they need to keep paying off, beyond what fast-check gives
every harness (see "Property tests run on fast-check" in the root
`CLAUDE.md`). A harness must be
checked for **sensitivity** — revert the fix and confirm it fails — because
the common outcome is a harness that models the system too politely to reach
the bug: `fuzz-voiceio` silently exercised a DEAD worklet node for many
iterations (the audio mocks accumulate nodes across a test, so
`findWorkletNode` returned the first-ever one) and passed with the bug
present. And the model has to stay **faithful to the protocol** — one
`config` frame per connection, a drain-stop only after a `done`, timers
advanced 1ms per op so a lagged message can cross later operations — or the
"violations" it reports are its own.

## The capture worklet (`worklets/capture-processor.ts`)

The single mic-capture processor. It flushes a `slice()` copy and keeps its own
buffer (re-reading a just-transferred view is how a mic once went
permanently deaf), with start/stop gating, a stop → flush → `stopped`-ack
protocol, and the dead-mic probe. Two guards remain load-bearing:
`instantiateWorklet`'s harness honors the transfer list (`structuredClone`
with `transfer`, which really detaches) and caps posted messages so a
runaway loop is a named failure rather than a hang, and
`worklets/capture-processor.test.ts` exercises the processor source.

## Consuming the client config

How the browser client reads `GET /client-config`. The endpoint itself is
the SDK's — see "Pre-connection client config" in `packages/aai/CLAUDE.md`.

`client()`'s config tier renders `DefaultRoot`, which fetches the config
(any failure degrades to the empty default, so older servers keep working)
and mounts the chat shell; the shell uses the server-declared `name` unless
`client({ name })` overrides it. A custom `component` ignores all of it.

**The session's per-attempt broker lookup uses `loadClientConfig`, not
`fetchClientConfig`** — it returns `null` for a lookup that produced no
answer, keeping that distinct from a server that answered and named no
`sessionUrl`. Degrading both to `{}` is fine for name/greeting and wrong
here: `session-core.ts` latches `serverIsBroker = false` on a config with
no `sessionUrl`, and that latch skips the broker fetch on every later
attempt. So one 503 — a sandbox mid-boot, or one that failed to start —
pinned the client to the platform's `/:slug/websocket`, whose WebSocket
redirect browsers do not follow (sessions go straight to the sandbox now),
with no route back even after the agent recovered. Only an ANSWERED lookup
may set the latch.

**There is no text-only mode.** Every pipeline agent declares a real TTS
provider, and the default `ChatView` always renders the voice `Controls`.
The snapshot's `apiUrl` field carries the programmatic WebSocket endpoint,
shown by `ApiUrlChip`. **It is the LONG-LIVING platform endpoint**
(`wss://host/:slug/websocket`), never the brokered sandbox tunnel URL the
session actually connects to — the tunnel URL dies with the sandbox (idle
eviction, redeploy), so surfacing it hands users a link that rots. The
platform endpoint stays valid: a plain upgrade on it resolves the live
sandbox (booting it like the client-config broker) and answers a 302
redirect to the sandbox's current session URL (`orchestrator-ws.ts`,
query preserved so `?sessionId=` resumes survive). Programmatic WebSocket
clients that follow handshake redirects land on the sandbox; browsers
don't follow WebSocket redirects, which is fine — the browser path is the
client-config broker.
