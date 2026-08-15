---
issue: TODO
status: proposed
last_updated: "2026-08-14"
---

# One durable session event stream

The session protocol already defines an event vocabulary — 21 named events — and
there is no way to subscribe to it. Instead, `host/` and `sdk/` carry **51
distinct `on*` callback options**, each threaded through a constructor to one
consumer. And the stream itself is ephemeral: a frame the client misses is gone,
which is why history restoration currently depends on the *client* replaying
what it happens to still hold.

This proposes one retained, indexed event stream with an envelope, and one
subscriber surface over it — the shape this repo has already built once, for
workflows.

**This depends on `research/2-durable-session-state.md`**, which builds the
per-session store this stream needs a backend from. See "Sequencing" at the end.

## The duplication, measured

`sdk/protocol.ts` declares **21** distinct event names — `speech_started`,
`reply_done`, `cancelled`, `agent_transcript`, `tool_call`, `tool_result`,
`agent_state`, `playback_progress`, `idle_timeout`, `audio_done`, … That is a
complete vocabulary for what happens in a session.

`host/` and `sdk/` separately declare **51** distinct `on*` option names —
`onReplyStarted`, `onReplyDone`, `onCancelled`, `onSpeechStarted`,
`onUserTranscript`, `onUserTranscriptPartial`, `onAgentTranscript`,
`onAgentTranscriptPartial`, `onToolCall`, `onToolCallDone`, `onToolResult`,
`onSttPartial`, `onSttFinal`, `onSttError`, `onTtsAudio`, `onTtsWords`,
`onTtsBoundary`, `onTtsError`, `onPlaybackProgress`, `onIdle`, `onSinkCreated`,
`onSessionEnd`, … Most are one option on one type, consumed by one caller, and
several are near-duplicates of a protocol event with a different name.

Three consequences:

- **A new observer means a new option**, threaded from the constructor that owns
  it to the code that fires it. There is no way for an AGENT AUTHOR to observe
  anything — every one of these is framework-internal wiring.
- **Naming has drifted from the protocol it mirrors**, and commands share the
  namespace with events: `cancel` and `reset` are client→server commands while
  `reply_done` and `speech_started` are server events, all in one union with one
  shape. eve separates messages/controls from the event stream for exactly this
  reason.
- **The stream is fire-and-forget.** Nothing is retained, nothing is indexed, and
  a dropped frame is unrecoverable — which is the root of the history-restoration
  arrangement described below.

## We already built the durable version — for workflows

`aai/host/workflow-api.ts` serves `GET /workflows/runs/:id/stream`, and
`packages/aai-ui/CLAUDE.md` documents properties that are exactly what a session
stream wants:

- Chunks are **RETAINED with the run rather than live-only**, so the route is
  equally a replay — "a page that reloads mid-run reads the whole thing by
  default".
- **`startIndex`** selects a position, and "negative counts back from the end".
- A read is **BOUNDED** by `streamTail()` — the last written index when the
  request arrived — and the `done` frame carries the run's own terminal state, so
  a reader re-opens from where it left off rather than holding a socket.
- Chunks **replay**, so "a page that mounts late — a reload, a second tab, a link
  opened tomorrow — reads from index 0 and arrives at the same list".

So the repo has a durable, indexed, replayable event stream for workflow progress
and an ephemeral one for voice sessions. Two mechanisms, one shape, and the
harder problem is on the side that has the weaker mechanism.

## Prior art: eve

eve has one NDJSON stream per session
(`docs/concepts/sessions-runs-and-streaming.md`) carrying a vocabulary of ~25
events named `noun.verb-past` — `session.started`, `turn.completed`,
`step.failed`, `action.result`, `message.appended`, `message.completed`. Three
parts are worth taking:

**The envelope.** Every event carries `meta: { id, at }`, where `id` is an
`evt_`-prefixed ULID minted once when the event is written and stored with it. It
is stable across reconnecting from a cursor, rewinding to `startIndex=0`, and
replaying a finished session — which makes it the key for ingesting a stream
into a database without duplicating rows.

eve is also precise about the limits, and each is a trap worth inheriting rather
than rediscovering:

- **Ids are time-ordered, not a total order.** Steps of one session can run in
  different processes; "do not use `where id > $cursor` as a lossless cursor.
  The stream itself is authoritative: `startIndex` is an absolute event count."
- **A retried step re-emits under new ids.** Both attempts carry the same
  `turnId`/`stepIndex`/`sequence` and "no field records which attempt finished".
  So `meta.id` deduplicates *delivery*, never *execution*.
- **Ids identify events, not intent** — a `step.failed` → `turn.failed` →
  `session.failed` cascade is three distinct events, so deduplicating on content
  would drop real data.

**The subscriber surface.** `defineHook` takes an `events` map keyed by event
type — `{ events: { "turn.completed"(e, ctx) {} } }` — with `*` matching every
event, and one documented execution order: emit (adapter
handler runs, event stamped, written durably) → hooks (typed first, then `*`) →
dynamic resolvers. Handlers are observe-only and cannot inject model context,
which is what keeps the stream a log rather than a second control path.

**`finishReason` distinguishes narration from a terminal reply.**
`message.completed` fires more than once per turn because "the agent often emits
interim assistant text before a tool call". AAI has this exact problem and no
answer on the wire: the pipeline marks filler `record: false` internally, so the
client cannot tell a hold phrase from an answer.

## Design

### The stream is CONTROL events only — audio stays out

This is the constraint eve never has to think about and the one that shapes
everything here. A session carries **384 kbps down and 256 kbps up of
uncompressed PCM**, and audio frames are already `ServerMessage`s. Retaining
them would be minutes of audio per call in Postgres for no reader.

So: the durable stream carries control events, and audio remains a separate,
unretained binary path. That split has to be explicit in the protocol rather
than implied, because "every event is durable" is otherwise the natural reading
and it is catastrophically wrong here.

`playback_progress` is the edge case to decide — it is a control event by shape
and per-frame by volume.

### Retention has a backing store, and it is doc A's

The stream needs somewhere to put events per session, with the same two
backends and the same selection rule: Postgres when the app has a database,
memory otherwise. `research/2-durable-session-state.md` builds exactly that
interface for slot values. This should be a **second consumer of that store, not
a second store** — otherwise the repo gets two per-session persistence
mechanisms, which is the failure this whole line of work is trying to remove.

That is the dependency: A first, C second.

### What it lets us delete

- **The 51 `on*` options collapse toward one subscribe surface.** Not all of
  them — the STT/TTS provider callbacks (`onSttPartial`, `onTtsWords`, …) are a
  provider adapter's contract, below the session, and belong where they are. The
  ones that go are the session-level observers that mirror a protocol event.
- **Client-side history replay is DELETED in the same change.** Today
  `aai-ui/session-core.ts:223-228` pushes its own `messages` back on reconnect
  because the server has no record. With an indexed stream, a resume is
  `?startIndex=N` and the server is authoritative — so the `history` client event
  (`sdk/protocol.ts:330`), `SessionCore.onHistory`, `transport.seedHistory`, and
  the client's replay block all go with it. Landing the stream while leaving the
  workaround in place would mean two mechanisms restoring the same thing, with the
  client's the one that actually runs; keeping it "until we trust the stream" is
  how the stream ends up never being trusted.
- **`agent_state` deduplication gets simpler.** `_state-sync.ts` keys `lastSent`
  in a `WeakMap` by the state object to avoid flooding the socket; a stream with
  an index gives the same guarantee positionally. (Doc 2 removes the bag that
  `WeakMap` is keyed on, so the two changes meet here.)

### What it gives authors that does not exist at all

An agent author cannot currently observe their own agent. Every one of the 51
callbacks is internal. A hook surface over the session stream is the first way to
write an audit log, per-turn metrics, or "persist every call to my own database"
— and `ctx.db` is already there to write to.

### A guest route is not reachable until the platform declares it

The stream is a route on the guest, and on a DEPLOYED agent a guest route works
only if `GUEST_ROUTES` + `GUEST_ROUTE_EXPOSURE` (`aai-server/guest-routes.ts`)
say how. A browser reading its own session's stream off the sandbox tunnel is
`direct-dial`, like the voice socket; an operator or an ingester reading through
the platform is `proxied`, with the methods the guest answers spelled out. That
table exists because this exact omission has shipped twice as "works under `aai
dev`, 404s once deployed" — `aai dev` serves the guest's own routes directly,
which is where this feature will be developed — and `guard-invariants` rule 12
now fails a route nobody wrote down.

**Reconnect by `startIndex` needs nothing from the platform, and that is
verified rather than assumed.** `orchestrator-ws.ts` answers the
`/:slug/websocket` upgrade with a 302 that copies the caller's ENTIRE query
string onto the sandbox's session URL — the mechanism today's `?sessionId=`
resumes already ride — so a cursor reaches the guest with no platform change.

**Retention sits in the tenant's schema, where the user can see it.**
`appDatabaseUsage` counts every base table in the app schema and the studio
surfaces that as the author's own database usage, so a tool-heavy call's control
events land in a number they read as their data. A second reason the audio path
stays out, and it makes the retention window a product decision rather than only
an operational one.

### Two files this cannot grow

`host/runtime.ts` is 489 lines and `host/session-core.ts` is 494, against a
500-line source cap whose allowlist is EMPTY and says "Do not add new entries;
refactor instead." Both are in this plan's scope. So the hook surface cannot be
wired in without splitting them first — and the deletion that would have bought
the room is `4-callback-surface-collapse.md`, which lands AFTER this. Either
split those two modules as part of this change, or pull the `runtime.ts` /
`session-core.ts` slice of doc 4 forward into it. Not a nit: the cap is a
gate in `pnpm check` and in CI, so it decides whether the change can land at all.

## Failure modes

- **At-least-once, and no key collapses a retry.** Inherit eve's exact framing:
  `meta.id` makes ingestion idempotent against re-delivery and says nothing about
  re-execution. A hook doing a non-idempotent side effect keys on turn
  coordinates; a hook storing content keys on `meta.id`.
- **A throwing hook must not corrupt the stream.** eve's rule — hooks run
  *after* the event is durably recorded — is the right one, and its escalation
  (a thrown handler surfaces as `turn.failed`) is deliberately NOT right for
  voice: a failing audit hook must not end a phone call. Non-fatal by default,
  the same rule `EmitError`'s `fatal: false` already encodes for turn-level
  errors.
- **Write volume.** A tool-heavy turn emits tens of control events. Retention has
  to be batched or the per-turn Postgres cost is many round trips inside a turn
  that has a ~1.0s TTFT budget. Deferring writes to turn boundaries is the
  obvious answer and needs measuring, not assuming.

## Scope

| Change | Where |
| --- | --- |
| Event envelope (`meta.id` ULID + `meta.at`) on control events | `sdk/protocol.ts` |
| Split the union: commands vs events vs audio frames | `sdk/protocol.ts` |
| Retained indexed stream over doc A's store; `startIndex` reads | `host/`, new module |
| Hook surface + execution order; non-fatal by default | `sdk/define.ts`, `host/` |
| Rename all 21 events to `noun.verb-past`; split commands out of the union | `sdk/protocol.ts`, every client |
| Regenerate the export snapshot — `update: "none"`, so it needs an explicit `vitest -u` | `sdk/__snapshots__/exports.test.ts.snap` |
| Reconnect by `startIndex`; **delete** the `history` event, `onHistory`, `seedHistory`, and the client replay block | `sdk/protocol.ts`, `host/ws-handler.ts`, `host/session-core.ts`, `aai-ui/session-core.ts` |
| Collapse the session-level `on*` options | `host/` (~51 audited, subset removed) |
| Split `runtime.ts` / `session-core.ts` — both within 11 lines of the 500 cap | `host/` |
| Declare the stream route and its exposure | `aai-server/guest-routes.ts` |
| Epoch bump for `aai:agent` as `--drop`; `/protocol` is exempt (non-authoring) | `contracts/` |

## Open questions

Event naming is **settled, not open**: the 21 names are renamed to
`noun.verb-past` in this change. The vocabulary is inconsistent today
(`reply_done` and `speech_started` beside bare nouns like `config`, `error` and
`agent_state`, with the client commands `cancel` and `reset` sharing the union),
and the rename is only cheap *before* the hook surface turns these names into
author-visible API — after that, every renaming is a break for every hook anyone
has written. There is no compatibility constraint now, so this is the last moment
it is free.

Relatedly, one piece of eve's design is deliberately NOT copied: its
`meta.id`-may-be-absent handling for events written before stream version 20. We
have no stored events at all, so the envelope is required from the first write
and nothing has to tolerate its absence.

- **Is `step` worth making addressable?** eve nests session → turn → step and
  gives every event `turnId`/`stepIndex`/`sequence`. AAI counts steps
  (`maxSteps`, `stopWhen`) but they are not addressable, so "which tool call in
  which step" has no coordinates. This is what makes eve's retry semantics
  expressible; whether a voice turn needs it is unsettled.
- **Does `playback_progress` belong in the durable stream?** Control by shape,
  per-frame by volume. Probably excluded with the audio path.
- **How long is retention?** Slot values follow the session's grace window; a
  stream a client may rewind is a different budget, and an audit hook writing to
  `ctx.db` arguably makes long retention the author's business rather than ours.
