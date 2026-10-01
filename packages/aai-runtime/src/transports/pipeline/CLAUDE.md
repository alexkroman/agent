---
summary: >-
  The pipeline transport's stage map and the one-way dependency direction between
  stages, the heard-history record, reset re-greeting, and `speakLine`
read_when: >-
  editing anything under `src/transports/pipeline/`
---

# The pipeline transport

Transport-wide rules (the capability table, prompt resolution) are in
[`../CLAUDE.md`](../CLAUDE.md).

## One directory per stage, and each is entered through its `index.ts`

| Directory  | Holds                                                                                        | May import                               |
| ---------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `turn/`    | the turn gate and chain, the turn state machine, the metrics frame                           | no other stage                           |
| `heard/`   | the heard cursor (`tracker.ts`), word alignment, playback clock, the recovery latch          | no other stage                           |
| `knobs/`   | a dialog state's and a persona's per-step model knobs                                        | no other stage                           |
| `output/`  | TTS coalescing and flush (`tts.ts`), guardrails, the speak gate, audio-out                   | `heard/`, `turn/`                        |
| `history/` | `PipelineHistory`, the context budget, record retention, heard-history                       | `heard/`, `output/`, `turn/`             |
| `reply/`   | the stream-part handler, code-initiated lines, the dead-air cover                            | `heard/`, `history/`, `turn/`            |
| `llm/`     | one `streamText` request: assembly, drain, tool speech, trace, smoothing, speculative stream | `history/`, `output/`, `reply/`, `turn/` |
| `speech/`  | STT in to a committed turn: edges, barge-in, push-to-talk, nudges, caps, speculation         | `heard/`, `history/`, `llm/`             |

The files beside this guide are the ASSEMBLY — `transport.ts`
(`createPipelineTransport`), `commands.ts` (its client verbs), `lifecycle.ts`
(once per call), `options.ts`, `providers.ts`, `session-signal.ts`,
`turn-body.ts` and `turn-outcome.ts` — and import every stage.

- **Outside a directory, import its `index.ts` and nothing else**; a name not
  re-exported there is private, so there is no `_` prefix inside these
  directories. Outside `pipeline/` that means `pipeline/index.ts` only.
  `guard-invariants` rule 37 enforces it for every importer, specs included —
  a spec that needs a private module lives beside it, and shared test
  scaffolding (`../_pipeline-transport-harness.ts`) lives outside.
- **The stage directions are `guard-invariants` rule 38**, whose
  `PIPELINE_STAGES` table (`scripts/guard-invariants-module-dirs.mjs`) is the
  "May import" column above; a stage spec is exempt, and a stage never imports
  the assembly (any file directly in `pipeline/`). Biome's `noImportCycles`
  only sees a cycle once it closes; the rule refuses the first wrong-way edge.
- **An `index.ts` lists exactly what is imported from outside** and is a pure
  barrel of named re-exports (konsistent `module-dir-index-is-re-export-only`).
- `speech/` reaches `llm/` only for speculation, and `history/` reaches
  `output/` only for `toModelMessage` (`tts.ts`).

## History records what was HEARD, not what was generated

An interrupted reply lands in history as the words the caller is estimated to
have heard, marked `[interrupted]`; a reply cut before anything was audible
records **no text** (its completed tool steps still count). TTS runs behind the
text, so recording everything told the model it had delivered what the caller
never got.

- **One cursor, one owner: `heard/tracker.ts` (`createHeardTracker`).** History
  truncation and the resume anchor (`buildTailResumePrompt`) both READ it, and
  it owns the playback clock the barge-in gate reads.
- **Two accuracy tiers, chosen at runtime**: word timings where the provider
  sends them (AssemblyAI `WordBoundaries`, `../../providers/tts/assemblyai-words.ts`);
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
  (`reply/lines.ts`) writes history once PLAYBACK ends, not synthesis.
- **A cut after the body committed is taken back too** (TTS drain, playback
  tail, a queued chained reply): `HeardTracker.markPersisted` keeps the reply on
  the clock until played, and `history/heard-history.ts` rewrites the record in
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
