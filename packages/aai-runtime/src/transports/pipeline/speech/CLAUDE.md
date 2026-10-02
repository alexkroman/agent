---
summary: >-
  The caller's side of the pipeline: `speech_started` as "the agent is yielding",
  speculation's prompt check, push-to-talk and typed turns
read_when: >-
  editing anything under `src/transports/pipeline/speech/`
---

# Pipeline speech

Stage map and import rules: [`../CLAUDE.md`](../CLAUDE.md).

## `speech_started` means "the agent is yielding", on BOTH transports

In S2S the service fires speech-started when it stops generating, so the event
coincides with a real interruption. Pipeline mode derives it from STT partials,
where the first word of a cough or backchannel would open it while
`interruption.minWords` / `.minDurationMs` correctly keep the agent talking.
Clients act on the event (tau2-bench discards its playout buffer on it), so
pipeline mode matches S2S:

- **While the agent holds the floor the edge is HELD**, released only when a
  barge-in really fires (alongside `cancelled`) or the agent stops on its own.
  While the agent is silent it passes straight through.
- Live captions are unaffected — `userTranscript.updated` is independent of the
  gate.
- **`edges.ts` owns it in two layers**: `createSpeechEdgeTracker` decides WHEN
  an utterance starts and ends (partials, finals, a watchdog for utterances that
  never commit); `createGatedSpeechEdges` decides WHETHER the client is told.
  `user-speech.ts` orchestrates.
- The property `../voice-events.test.ts` pins: **a benchmark score must not
  depend on whether a client truncates on `speech_started` or on `cancelled`.**
  A lower measured yield rate after this change is correct — do not "fix" it by
  reverting the gate.

## A speculation is built on one prompt

**A speculation records the prompt it was BUILT on, and adoption re-checks it**:
preemptive generation starts from an interim, a phase can advance before the
final, and `system` cannot be amended mid-stream, so `take()` discards with
`prompt-moved` (like `history-moved`). The controller resolves ONCE and hands
the string to `start`.

## Push-to-talk holds the turn in the TRANSPORT

`agent({ turnTaking: { detection: "manual" } })` moves the end of turn to the
client. `manual-turn.ts` owns it: finals are HELD while a turn is open and
answered as one on `user_turn_commit`; the mic is SILENCED with zeros outside a
turn (the transcriber's clock keeps pace); a final with no turn open is dropped.
Opening a turn is the barge-in — `startUserTurn()` reports whether it
interrupted and `../../../session/commands.ts` then acts like a client `cancel`
(`manualTurn` in the table). The eval harness's `say()` presses and releases for
a manual agent.

**A typed turn (`user_text`) is a committed transcript with no transcriber.**
`Transport.sendUserText` → `commitTypedTurn` in `user-speech.ts` cuts a reply in
flight or playing (reporting `reply.cancelled` BEFORE the
`userTranscript.committed`, so the stream's order is right), then commits on the
same path a final does, under either `turnTaking.detection` (`typedTurn` in the
table).
