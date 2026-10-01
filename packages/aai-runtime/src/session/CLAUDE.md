---
summary: >-
  One session: the attach lifecycle and socket adapter, the two inbound
  vocabularies, hook commits, and the session directory
read_when: >-
  editing anything under `src/session/`
---

# aai-runtime `session/`

Package-wide rules are in [`../../CLAUDE.md`](../../CLAUDE.md); the flat
`src/` modules' in [`../CLAUDE.md`](../CLAUDE.md). Outside this directory,
import its `index.ts` only (`guard-invariants` rule 37).

## A session reaches its client through ONE lifecycle; the socket is an adapter

`attach.ts` is the transport-neutral lifecycle of one client
connection: claim the id (evicting a superseded session on resume), announce
`session.configured`, start under the deadline, buffer input while starting and
replay it once ready, report a failed start, and run end-of-session cleanup
exactly once. It takes a `ClientSink` and returns an `AttachedSession`
(`sendAudio`, `sendCommand`, `detach`, `ended`). The phase machine is
`ws-lifecycle.ts`.

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
  [`../telephony/CLAUDE.md`](../telephony/CLAUDE.md).

## The session takes two VOCABULARIES, not nineteen callbacks

`ServerSession` takes `command(cmd)` — one `SessionCommand`, what the CLIENT
asks for — and `report(event)` — one `TransportEventBody`, what the TRANSPORT
observed. `TransportCallbacks` is the same `report` from the other side. That
plus the two audio paths is the whole inbound surface. `guard-invariants` rule
16 checks the first rule per file:

- **A callback survives only when there is NO EVENT for it** — binary audio,
  `onReplyStarted` (the wire has no `reply.started`; minting one is a protocol
  change), `onSessionReady`, and socket-lifecycle hooks a caller must ACT on.
- **Report `agentTranscript.committed` or `.updated`, never a boolean.** Only
  the committed one enters history.
- **`reply.completed` is the PROVIDER's claim, not the turn's end** — see
  `reply-done.ts`.
- **Audio never joins the hook surface**: `playback_progress` is a
  client→server command and audio frames are binary, so neither is an event.
  Handlers run synchronously off `emit` and async ones are never awaited, so a
  subscriber cannot add turn latency.

- **The core never asks WHICH transport it drives** — it reads the transport's
  `capabilities`. `hostedTurn` decides what `tool.called` means: an observation
  the host's own model loop already ran (publish it, unless a relay did), or a
  request the session executes through `tool-steps.ts`. Both run the one call
  core, `../tools/run-tool-call.ts`. The runtime's callbacks are a flat forward.

`../transports/types.ts` holds the boundary and argument; `core.ts` and
`commands.ts` own the two dispatchers.

## A hook's write needs a commit, and a guard

`agent({ events })` handlers may WRITE session state (authoring half:
`packages/aai/src/sdk/CLAUDE.md`, "A session event hook WRITES state and may
SAY, but cannot change the turn"). Both mechanics live in `emitter.ts`:

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
  client but announces nothing. Removing it makes `emitter.test.ts`
  overflow the stack — keep that test.

`commitSessionState` is absent on the SANDBOX tool path (the runtime holds no
state there): a hook's write still lands in the store, without the commit.

## `say` and `interrupt` reach a session through ONE directory

`speech.ts` is the host half of the SDK's `SessionSpeech`.
`createSpeechVerbs` is one session's pair: `interrupt()` IS the client `cancel`
command (so a cut from code and one from the client report the same
`reply.cancelled`), and answers `false` only when `Transport.isReplying` says
the agent is silent. `say` goes to `Transport.speakLine`, or settles
`"dropped"` when the transport lacks the `say` capability (said once at session
start — `../transports/CLAUDE.md`, "What works on which transport").

- **Every reach for a live session goes through ONE `SessionDirectory`**
  (`directory.ts`, built once in `../runtime/runtime.ts`), resolved per CALL: the
  session (`attach.ts`'s resume takeover claims it), its emitter and
  meter (`ctx.send`, a hook commit, `ctx.generate`), and `speech` — `of(sid)`
  for a tool or handler context (a timer can fire after a resume swapped the
  session), `live(sid)` for `RouteContext.speech`, `announce` for a run's
  `notify`. Never capture a `ServerSession` in a context; `guard-invariants`
  rule 36 refuses a session-keyed map anywhere else in the package.
- A sessionless context (a step's `stepDelegate`, an unwired double) holds
  `DETACHED_SESSION_SPEECH` from `/host-internal`: every line `"dropped"`.
