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

## `speech_started` means "the agent is yielding", on BOTH transports

In S2S the service fires speech-started when it stops generating, so the event
coincides with a real interruption. Pipeline mode derives it from STT partials,
where the first word of a cough or backchannel would open it while
`minBargeInWords` / `interruptionMinDurationMs` correctly keep the agent
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

| Transport | Resolves | Why there |
| --- | --- | --- |
| pipeline | at each `startLlmStream` | the one place a `streamText` request is assembled |
| OpenAI Realtime | at open, then on `refreshSystemPrompt()` | `instructions` is service state; sends an `instructions`-only `session.update`, only on a change |
| AssemblyAI S2S | **once, at construction** (`buildAssemblyS2sTransport`) | the service runs the tool loop; the host has no moment between turns |

So an S2S agent learns about a `dialog()` phase through tool results alone.

**A speculation records the prompt it was BUILT on, and adoption re-checks
it**: preemptive generation starts from an interim, a phase can advance before
the final, and `system` cannot be amended mid-stream, so `take()` discards with
`prompt-moved` (like `history-moved`). The controller resolves ONCE and hands
the string to `start`.

## A step's REQUEST is bounded in tokens; the message cap only guards growth

`DEFAULT_MAX_HISTORY` counts messages, which does not predict request size.
`pipeline-context-budget.ts` trims as a **`prepareStep` preparer**, so
`PipelineHistory` keeps everything (replay, resume and `ctx.messages` read it)
and only the request is trimmed. The window is
`ASSEMBLYAI_GATEWAY_MODELS.context` less `CONTEXT_WINDOW_RESERVE`; an unknown
window yields NO preparer; the count is calibrated per SESSION against reported
`usage.inputTokens`. The module doc carries the argument.

**Preparers COMPOSE** (`../_prepare-step.ts`): the budget owns `messages`,
`forceFinalAnswer` goes last and owns `toolChoice`. Writing either straight
into the slot silently deletes the other.

## A rollback must undo the eviction its push caused

`pipeline-history.ts` keeps two capped views. `dropTrailingUser` rolls back an
injected prompt (false-interruption resume, silence nudge, `injectTurn`), and at
`DEFAULT_MAX_HISTORY` a bare pop would lose the message the push trimmed. A push
records what it evicted and the pop that undoes THAT push restores it. Argued at
`PushUndo`: one slot PER VIEW, recorded only for a single-message push,
consumed by IDENTITY; `capLlm`'s healed tool-pair halves count as part of the
eviction. Oracle: `../integration/pipeline-history-rollback.integration.test.ts`,
plus two pins in `pipeline-history.test.ts`.

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
- **Neither S2S transport re-greets — a known gap.** AssemblyAI S2S has no
  `reset()` verb; OpenAI Realtime could re-issue `response.create` but the
  service still holds the conversation, and clearing it means deleting every
  tracked `conversation.item`.

## Push-to-talk holds the turn in the TRANSPORT

`agent({ turnDetection: "manual" })` moves the end of turn to the client.
`pipeline-manual-turn.ts` owns it: finals are HELD while a turn is open and
answered as one on `user_turn_commit`; the mic is SILENCED with zeros outside a
turn (the transcriber's clock keeps pace); a final with no turn open is dropped.
Opening a turn is the barge-in — `startUserTurn()` reports whether it
interrupted and `session-commands.ts` then acts like a client `cancel`. Both
S2S transports omit the verbs. The eval harness's `say()` presses and releases
for a manual agent.

## A run can tell the caller it finished

`start(def, input, { key, notify })` makes the starting session take an
unprompted, interruptible turn when the run lands. `Transport.injectTurn` is the
primitive — pipeline only; on S2S a logged no-op. See `../workflow/notify.ts`.
