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

## A STATIC page is `page()`, not `client()`

An agent with `page: "static"` (see `packages/aai/CLAUDE.md`) has no session, so
its `client.tsx` mounts with **`page()`** (`page.tsx`) and talks to the workflow
HTTP API through **`createWorkflowApi()` / `useWorkflowRun()`**
(`workflow-client.ts`).

**Two mounts rather than a flag on `client()`, and the reason is what `client()`
unavoidably does**: it constructs a `SessionCore`, which owns a WebSocket URL
provider, an audio graph and a microphone request. A `session: false` option
would make all of that conditional and then leave every session hook having to
answer "what does this mean with no session?" — so the split is honest. Authoring
is otherwise identical (still `client.tsx`, still React, still Tailwind, and
`ThemeProvider` is installed either way), which is why the workflow templates read
like every other template.

**`useWorkflowRun` POLLS, and that is not a limitation to fix.** A run is durable
and the page is not: it can complete while the tab is closed, on another sandbox,
hours later. There is no socket to push down and nothing to reconnect — the
`runId` is the whole state, so re-reading it is both the simplest and the most
honest implementation. Three properties it needs to keep: polling STOPS on a
terminal status (a finished run costs nothing, and a page left open must not poll
forever), the timer is re-armed from the SETTLED read rather than on an interval
(so a slow response cannot stack overlapping polls), and a failed read is
REPORTED but retried — a dropped request against a booting sandbox is the common
case, and giving up would strand a live run.

**Bytes go through `api.upload()`, never into the run input.** The input is
journaled and replayed, so the page uploads first and passes the returned
`blobId` — see the `/blobs` note in `packages/aai/CLAUDE.md`. `transcription-desk`
is the worked example: it decodes the picked file with `decodeAudioData`,
downmixes and resamples through an `OfflineAudioContext` (which band-limits
properly — hand-rolled decimation aliases), slices into 60 s windows, and uploads
each as S16LE PCM.

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
