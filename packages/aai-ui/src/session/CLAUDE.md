---
summary: >-
  The browser session core as a module directory: what `index.ts` exports and
  why, the statecharts (agent state and the fatal latch, the audio path),
  pre-connect audio, drain completion across turns, and the handshake guard.
read_when: >-
  editing anything under `packages/aai-ui/src/session/` — `createBrowserSession`,
  the dialer, reconnect, ticket, message handling, the audio path's bring-up —
  or its specs and fuzz harnesses.
---

# `src/session/` — the browser session core

`createBrowserSession` (`browser-session.ts`) and the modules it is split
across. Paths outside this directory are relative to `src/`; the client-config
lookup, the inbox and the public hooks are in `../CLAUDE.md`.

## The directory is a module

- **`index.ts` is the only import surface** for the rest of the package; every
  other file here is private (not re-exported). Guard-invariants rule 37 fails
  an import from outside `session/` naming any other file, specs included — a
  spec that needs a private module lives here (the session suites and
  `fuzz-session.test.ts` / `fuzz-reconnect.test.ts` do).
- **`index.ts` is re-export only** (konsistent
  `module-dir-index-is-re-export-only`). Beyond `createBrowserSession` and the
  handle's types it exports three names for in-package callers: `ticketCarriage`
  (the inbox presents its ticket the same way), `CLEARED_SESSION_STATE` (the
  mock session in `_react-test-utils.ts` starts from it) and `loadAudioModules`
  (specs outside await it once, because it is real I/O fake timers cannot pump).
- **The audio layer is reached through `audio/index.ts` by DYNAMIC `import()`
  only** (`audio-setup.ts`, `preconnect.ts`), which keeps `audio/` a lazy chunk;
  `import type` from it is free. `audio/` may not import `session/` (konsistent
  `ui-audio-imports-no-session`).
- `../_session-core-test-utils.ts` (the mock WebSocket, `makeConfig`) stays at
  `src/`: the inbox, `mountClient()` and `useSessionId` specs dial through it
  too.

## A FATAL error survives the frames that follow it

The host's fatal paths `terminate()`, which emits `cancelled` — so the frame
announcing death must not wipe the banner. The fatal branch of
`handleErrorEvent` latches; every recovery path is declined while latched;
**only the next `config` frame clears it** (a completed handshake, per
CONNECTION, so a retry reaching a healthy peer is not pinned to the old banner).
A NON-fatal error (`fatal: false`) is still retired by later activity.

- **`state.ts` owns `state` and `error`.** The seven `AgentState` names are one
  region; the fatal latch is a SECOND region (`stateIn({ fatal: "yes" })`),
  because it outlives the `error` phase (`error → connecting → ready`). Callers
  send what HAPPENED (`LISTEN`, `ACTIVITY`, `SPEAK`, `THINK`) and fold the
  projection into one `updateState`. Never write `state`/`error` directly or
  guard a write by reading the snapshot back.
- **XState falls through to an ancestor's handler when a child's guard fails**,
  so every handler that clears the banner carries the fatal guard.
- A declined transition returns the position unchanged; `updateState` drops
  snapshots that differ in nothing (pinned by `messages.test.ts`).

## The audio path is a statechart (`audio-state.ts`)

`down` / `starting` / `up`; bring-up is an `invoke`, so hang-up, reconnect or a
fatal frame STOPS it. `PROGRESS`/`IO_FAILED` carry the instance that fired them
(a repeated `config` frame makes two bring-ups; the outgoing one must not tear
down its replacement). `preInitAudio`/`preInitDone` are context cleared by
entering `down`.

- **Cancellation does not close a mic the browser already granted**: `bringUp`
  checks its own `signal` after `open` settles and releases what it built. That
  is the only "still wanted?" check — do not add generation counters or flags
  back on `ConnState`.
- The machine touches no socket or snapshot; effects are `audio-effects.ts`,
  setup is `audio-setup.ts`, so `audio-state.test.ts` specs it without a
  browser.

## Pre-connect audio (`preconnect.ts`)

The mic opens on `connect()`, not on `config`, so an opener spoken while the
agent joins is buffered (latest `PRE_CONNECT_MAX_SECONDS`) and sent ahead of
live audio. Opt out with `preConnectAudio: false`.

- **It captures at a GUESSED rate (16 kHz)**: `createVoiceIO({ preConnect })`
  adopts the context and node whole on a match, else keeps only the grant and
  resamples the buffer with `OfflineAudioContext` (`audio/preconnect.ts`).
- **The buffer reaches the wire before any live frame**: the flush and the sink
  swap are synchronous, and the burst bypasses the mic's backpressure drop
  (`sendBuffered`) while still honouring mute.
- **Ownership**: the holder until the bring-up `take()`s it, then the bring-up
  (every rejection in `openAudioPath` closes it). A reconnect BEFORE `config`
  keeps it buffering; only terminal paths `release()` it. A release that lands
  while the audio modules still load stops the attempt BEFORE `getUserMedia` —
  closing it after the grant would still light the recording indicator.

## Drain completion outlives the turn

`done()` resolves when the worklet drains, which also happens when the
AudioContext stops — possibly after the turn or session is over. Two guards:

- **The turn epoch lives on `ConnState.turn`**, bumped by the audio path's
  `endTurn` effect on every committed user turn, barge-in, reset — and on
  entering `down`, since teardown is a turn boundary. Otherwise a late drain
  writes `"listening"` over `"disconnected"`/`"error"`.
- **The worklet's `stop` echoes its turn id** and `audio/voice-io.ts` settles
  only the matching wait (details in `../worklets/CLAUDE.md`).

The server side paces audio at a bounded lead
(`aai-runtime/session/audio-pacer.ts`): `CLIENT_AUDIO_LEAD_MS` **must stay above
`PLAYBACK_JITTER_MS`**; `audio_done` is queued BEHIND held audio;
`cancelled`/`reset` DISCARD held audio.

## The connection is a statechart (`connection.ts`)

`link`: `closed` / `open` (`dialing → awaitingHandshake → live`), plus a
`retired` region (the server's `session.timedOut`; cleared only by the next
`connect()`). `open`'s ENTRY dials and its EXIT is the one teardown (detach,
pre-connect release, audio teardown, socket close) — exit, not an invoke's
cleanup, because XState defers that past the transition's actions and the
teardown must precede the snapshot write reporting the end. partysocket owns the
backoff: a close it will retry (`reconnectPending`, read inside the `close`
listener) goes back to `dialing` unless the session is fatal or retired.

### A handshake is not a session (`handshake.ts`)

An open socket proves only a `101`; the server sends `config` at zero RTT, and
partysocket's `connectionTimeout` stops at `open`. Without a deadline a wedged
peer leaves the session on `"ready"` (painted as live) forever. The deadline is
`awaitingHandshake`'s `after`: leaving the state disarms it. On expiry it
re-dials (`forceReconnect`); after `MAX_HANDSHAKE_TIMEOUTS` it surfaces a
`connection` error.

- **Its budget is its own** — `reconnect()` resets partysocket's retry count, so
  `RECONNECT_OPTIONS.maxRetries` cannot bound this.
- **The budget is CONSECUTIVE**: a `config` frame resets it; a close must NOT,
  or a wedged peer re-dials forever.
