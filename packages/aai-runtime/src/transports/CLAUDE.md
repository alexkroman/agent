---
summary: >-
  Pipeline and S2S transport behaviour: `speech_started`, per-turn prompt
  resolution, heard-history, the context budget, rollback at the cap, reset,
  push-to-talk
read_when: >-
  editing a `pipeline-*` or `openai-realtime-*` module, or anything under
  `src/transports/`
---

# aai-runtime transports

`types.ts` is the transport boundary; session-side rules are in
[`../CLAUDE.md`](../CLAUDE.md).

## What works on which transport is ONE descriptor

`Transport.capabilities` (`capabilities.ts`) answers every "can this transport
do X"; read the flag, never a verb's presence, and never add an "S2S cannot"
branch at a call site. An absence is handled at `agent()` (`config-rules.ts`
refuses by mode), once at session start (`reportSessionCapabilities`), or as an
ignored client command. The table is RENDERED by `renderCapabilityTable()` and
`capabilities.test.ts` holds it, and each optional verb, to the descriptors —
edit the rows there, then paste the output here:

<!-- capability-table:start -->

| capability         | feature                                                                                      | pipeline | OpenAI Realtime | AssemblyAI S2S | where absent                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------- | -------- | --------------- | -------------- | -------------------------------------------------------------------------------------- |
| `say`              | `speech.say()` — speak host text VERBATIM (`interruptible`, `record`)                        | yes      | no              | no             | logged at session start; every `say` settles `dropped`                                 |
| `replyState`       | `speech.interrupt()` knows whether a reply is in flight                                      | yes      | no              | no             | "cannot tell" interrupts, as the client's blind `cancel` does                          |
| `announce`         | an unprompted MODEL turn — a run's `notify`, `ServerSession.announce`                        | yes      | no              | no             | logged at session start; `announce` answers `false`                                    |
| `typedTurn`        | a typed user turn (`user_text`)                                                              | yes      | no              | no             | client command ignored, warned once per session                                        |
| `manualTurn`       | push-to-talk (`turnTaking: { detection: "manual" }`)                                         | yes      | no              | no             | refused by `agent()`; client commands ignored, warned once per session                 |
| `reset`            | client `reset` clears the conversation and re-greets                                         | yes      | no              | no             | ignored — the service holds the conversation (a known gap)                             |
| `seedHistory`      | a resume re-seeds the host-held model history                                                | yes      | no              | no             | nothing to seed — the service resumes its own context                                  |
| `playbackProgress` | client `playback_progress` corrects the heard clock                                          | yes      | no              | no             | ignored — the host keeps no playback model                                             |
| `promptPush`       | a changed system prompt is PUSHED to the service                                             | no       | yes             | no             | pipeline: resolved per request, nothing to push                                        |
| `perTurnPrompt`    | the system prompt is re-resolved between turns (a `dialog()` phase, a persona)               | yes      | yes             | no             | resolved ONCE at construction; a phase is learned through tool results                 |
| `dialogKnobs`      | a dialog state's `interruption` / `toolChoice` / `temperature`                               | yes      | no              | no             | warned at session start; states, deadlines and tool gates still work                   |
| `personaKnobs`     | a persona's `interruption` / `toolChoice` / `temperature`                                    | yes      | no              | no             | warned at session start; the prompt section and tool gate still hold                   |
| `fatalTool`        | a tool's `onError` FATAL verdict stops the turn and speaks `errorPhrase`                     | yes      | no              | no             | warned at session start; a fatal verdict reaches the model as a failure result instead |
| `turnMetrics`      | one `metrics.collected` frame per settled reply (`pipeline-turn-metrics.ts`)                 | yes      | no              | no             | no frame — the service reports no per-stage marks (a known gap)                        |
| `hostedTurn`       | the HOST runs the model turn: guardrails, `usageLimits`, model tuning, pipeline voice tuning | yes      | no              | no             | refused by `agent()` (`config-rules.ts`) — never reaches a session                     |

<!-- capability-table:end -->

## `speech_started` means "the agent is yielding", on BOTH transports

In S2S the service fires speech-started when it stops generating, so the event
coincides with a real interruption. Pipeline mode derives it from STT partials,
where the first word of a cough or backchannel would open it while
`interruption.minWords` / `.minDurationMs` correctly keep the agent
talking. Clients act on the event (tau2-bench discards its playout buffer on
it), so pipeline mode matches S2S:

- **While the agent holds the floor the edge is HELD**, released only when a
  barge-in really fires (alongside `cancelled`) or the agent stops on its own.
  While the agent is silent it passes straight through.
- Live captions are unaffected — `user-transcript.updated` is independent of
  the gate.
- **`pipeline-speech-edges.ts` owns it in two layers**:
  `createSpeechEdgeTracker` decides WHEN an utterance starts and ends (partials,
  finals, a watchdog for utterances that never commit);
  `createGatedSpeechEdges` decides WHETHER the client is told.
  `pipeline-user-speech.ts` orchestrates.
- The property `pipeline-voice-events.test.ts` pins: **a benchmark score must
  not depend on whether a client truncates on `speech_started` or on
  `cancelled`.** A lower measured yield rate after this change is correct — do
  not "fix" it by reverting the gate.

## The system prompt is resolved PER TURN, and one transport cannot

`TransportSessionConfig.systemPrompt` is a `SystemPromptOption` (`string |
(() => string)`) with one reader, `resolveSystemPrompt` (`types.ts`) — one
field, not a string plus a resolver, so no read site has a precedence to forget.
A plain string resolves to itself. This is a transport seam, NOT the authoring
`AgentSystemPrompt`, which needs the session and is resolved in
`runtime-system-prompt.ts`.

| Transport       | Resolves                                                | Why there                                                                                        |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| pipeline        | at each `startLlmStream`                                | the one place a `streamText` request is assembled                                                |
| OpenAI Realtime | at open, then on `refreshSystemPrompt()`                | `instructions` is service state; sends an `instructions`-only `session.update`, only on a change |
| AssemblyAI S2S  | **once, at construction** (`buildAssemblyS2sTransport`) | the service runs the tool loop; the host has no moment between turns                             |

So an S2S agent learns about a `dialog()` phase through tool results alone.

**A speculation records the prompt it was BUILT on, and adoption re-checks
it**: preemptive generation starts from an interim, a phase can advance before
the final, and `system` cannot be amended mid-stream, so `take()` discards with
`prompt-moved` (like `history-moved`). The controller resolves ONCE and hands
the string to `start`.

## History is budgeted in TOKENS everywhere; there is no message cap

- **The REQUEST** is bounded only by `pipeline-context-budget.ts`, a
  **`prepareStep` preparer**, so `PipelineHistory` keeps everything (replay,
  resume and `ctx.messages` read it) and only the request is trimmed. The window
  is `ASSEMBLYAI_GATEWAY_MODELS.context` less `CONTEXT_WINDOW_RESERVE`; an
  UNKNOWN window is budgeted as the smallest the catalog carries
  (`UNKNOWN_MODEL_CONTEXT_TOKENS`), because nothing else bounds the request; the
  count is calibrated per SESSION against reported `usage.inputTokens`.
- **The RECORD** is bounded for memory only, also in tokens
  (`../_history-retention.ts`, `HISTORY_RETAIN_TOKENS` = 2 x
  `LARGEST_CONTEXT_TOKEN_BUDGET`), and that size is what makes it unable to
  change a request: the budget sends a suffix no larger than its limit, and
  retention always keeps a larger one (`_history-retention.test.ts` states it
  as a property). The same bound applies in `session-core.ts` and to a resume
  (`historyFromEvents`); the event log itself stays whole.
- **The one count left is a DISPLAY bound**: `MAX_CLIENT_MESSAGES` caps what a
  `history.restored` frame carries (`clientHistoryFrame`) and what `aai-ui`
  keeps in its snapshot.

**Preparers REGISTER into one pipeline** (`../_prepare-step.ts`):
`composePreparers([{ stage, prepare }, …])` layers them in `PREPARER_ORDER`
(budget → agent reset → persona → dialog → error budget → `forceFinalAnswer`)
whatever order a call site lists them in, last writer winning per key. Writing
any preparer straight into the slot silently deletes the others, so
`guard-invariants` rule 35 rejects a `prepareStep:` in this package whose value
is not a `composePreparers(…)` call; a new concern is a new stage.

## A rollback must undo the eviction its push caused

`pipeline-history.ts` keeps two views, each retained to the token bound.
`dropTrailingUser` rolls back an injected prompt (false-interruption resume,
silence nudge, `injectTurn`), and at the bound a bare pop would lose what the
push evicted. A push records what it evicted and the pop that undoes THAT push
restores it. Argued at `PushUndo`: one slot PER VIEW, recorded only for a
single-message push, consumed by IDENTITY; a tool pair `evictLlm` took whole
counts as part of the eviction. Oracle:
`../integration/pipeline-history-rollback.integration.test.ts` (driven at a small
`retainTokens`), plus two pins in `pipeline-history.test.ts`.

## History records what was HEARD, not what was generated

An interrupted reply lands in history as the words the caller is estimated to
have heard, marked `[interrupted]`; a reply cut before anything was audible
records **no text** (its completed tool steps still count). TTS runs behind the
text, so recording everything told the model it had delivered what the caller
never got.

- **One cursor, one owner: `pipeline-heard.ts` (`createHeardTracker`).** History
  truncation and the resume anchor (`buildTailResumePrompt`) both READ it, and
  it owns the playback clock the barge-in gate reads.
- **Two accuracy tiers, chosen at runtime**: word timings where the provider
  sends them (AssemblyAI `WordBoundaries`, `providers/tts/assemblyai-words.ts`);
  otherwise a proportional estimate snapped to a word. Both round toward
  UNDER-keeping.
- **The proportional estimate is CLAMPED** (`MAX_SPEECH_CHARS_PER_MS`), because
  text runs ahead of synthesis and `spoken.length / audioMs` is not a speech
  rate. The constant's doc carries the arithmetic.
- **`HEARD_AUDIO_LAG_MS` is derived** — its row in `packages/aai/DEFAULTS-CLAUDE.md`'s
  defaults table has the decomposition; do not restate it.
- **The caption and the history entry diverge on purpose.** Never emit an
  `agent_transcript` after `cancelled` to "correct" the caption — that is the
  double-transcript bug (`persistInterruptedTurn`).
- The audio gate drops a cancelled turn's late audio AND word timings.
  `emitText`'s `record` flag decides what may be truncated into history; filler
  moves the heard position and is never recordable, and the TTS coalescer
  flushes when the flag flips.
- **The greeting follows the same rule**: `createLineReply`
  (`pipeline-lines.ts`) writes history once PLAYBACK ends, not synthesis.
- **A cut after the body committed is taken back too** (TTS drain, playback
  tail, a queued chained reply): `HeardTracker.markPersisted` keeps the reply on
  the clock until played, and `pipeline-heard-history.ts` rewrites the record in
  place. Logs `Pipeline heard-history truncated`.

## A `reset` starts a conversation, so it GREETS

The client `reset` frame discards the conversation, so `reset()` ends with
`lifecycle.greet()` — queued AFTER `gate.invalidateAll()` and on the turn
chain, so it runs after the aborted turn unwinds.

- **`skipGreeting` does not reach `greet()`** — it is a RESUME flag scoped to a
  connection's start, the opposite claim from a reset. (Hence `aai-ui`'s
  `reset()` drops the resume identity when the socket is already closed.)
- **Neither S2S transport re-greets — a known gap** (`reset` in the table):
  OpenAI Realtime could re-issue `response.create`, but the service still holds
  the conversation, and clearing it means deleting every tracked
  `conversation.item`.

## Push-to-talk holds the turn in the TRANSPORT

`agent({ turnTaking: { detection: "manual" } })` moves the end of turn to the client.
`pipeline-manual-turn.ts` owns it: finals are HELD while a turn is open and
answered as one on `user_turn_commit`; the mic is SILENCED with zeros outside a
turn (the transcriber's clock keeps pace); a final with no turn open is dropped.
Opening a turn is the barge-in — `startUserTurn()` reports whether it
interrupted and `session-commands.ts` then acts like a client `cancel`
(`manualTurn` in the table). The eval harness's `say()` presses and releases
for a manual agent.

**A typed turn (`user_text`) is a committed transcript with no transcriber.**
`Transport.sendUserText` → `commitTypedTurn` in `pipeline-user-speech.ts` cuts a
reply in flight or playing (reporting `reply.cancelled` BEFORE the
`user-transcript.committed`, so the stream's order is right), then commits on
the same path a final does, under either `turnTaking.detection` (`typedTurn` in
the table).

## Every code-initiated line states `{ record, interruptible }`

`LineFlags` (`types.ts`) is the pair `speech.say()` takes, and every word no
model token produced states it. `pipeline-lines.ts`'s module table lists each
line, its flags and its placement: a reply of its own (`createLineReply`), a
failed turn's last words (`speakFixedLine`), or INSIDE the reply in flight
(`speakInReply` — dead-air filler and tool messages, through the stream-part
handler's separator and transcript). Never spell a send for a new line; pick a
placement. The silence nudge and `notify` are model turns, not lines.

## `speakLine` is the greeting's path for any caller

`Transport.speakLine(text, { signal, onStart })` (the SDK's `speech.say`) queues
a VERBATIM line on the turn chain and speaks it through `createLineReply`, so a
`say` follows every greeting rule: captioned once, interruptible, history
written as HEARD once playback ends. It resolves `"played"`, `"interrupted"` or
`"dropped"` and never rejects.

- **A line asked for before TTS is adopted is HELD** and queued by
  `onAudioReady` behind the greeting; teardown drops held lines. Without the
  hold a webhook's line on a fresh call "played" into no socket.
- **The queue epoch is read when the line is ASKED for**, not when it reaches
  the chain, so an interrupt drops a held line as it drops a queued one.
  `TurnChain.chain`'s `onStranded` answers for a line the gate stranded.
- `isReplying()` is `turns.inFlight() || heard.pending()` (`say` and
  `replyState` in the table).
- **`interruptible: false` HOLDS THE FLOOR** for exactly that line:
  `knobs.holdFloor` makes `minBargeInWords` `Infinity` (a dialog's
  `interruption: "off"`) from before the line starts until it settles, so the
  caller is still transcribed and answered afterwards. Cancels, interrupts and
  typed turns ignore it. **`record: false`** captions with `recorded: false`
  and skips `createLineReply`'s history writes.

## A run can tell the caller it finished

`start(def, input, { key, notify })` makes the starting session take an
unprompted, interruptible turn when the run lands. `Transport.injectTurn` is the
primitive (`announce` in the table). See `../workflow/notify.ts`.
