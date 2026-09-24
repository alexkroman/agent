---
summary: >-
  The capture and playback AudioWorklets: the jitter buffer, gap concealment,
  underrun stats, capture sample rate and constraints, the dead-mic probe, and
  the worklet stress/bench harnesses.
read_when: >-
  editing a worklet processor, its tests, or a playback tuning constant.
---

# `src/worklets/` — capture and playback processors

Both legs are **raw PCM16 over the session WebSocket** (384 kbps down at 24 kHz,
256 kbps up at 16 kHz, mic open continuously for barge-in). A jitter buffer
absorbs jitter; no buffer size fixes a link that cannot carry that bitrate.

Tuning measurements (`PLAYBACK_JITTER_MS`, `PLAYBACK_REFILL_MS`, what the server
pacer costs playback) are in [`../../PLAYBACK-CLAUDE.md`](../../PLAYBACK-CLAUDE.md),
read on demand. Tune against a REAL recorded reply (`../fixtures/tts-reply-24k.pcm`,
`playback-tuning.test.ts`), not a generated one.

## Playback (`playback-processor.ts`)

- **A jitter buffer with hysteresis, not a startup delay.** It fills to
  `PLAYBACK_JITTER_MS` before a turn speaks and, on an underrun, returns to
  filling — to the shorter `PLAYBACK_REFILL_MS`. The re-arm is the point: gating
  only the start of a turn turns one stall into ~5 ms fragments for the rest of
  the reply. A starved quantum never advances `readPos`.
- **Gaps are concealed, not zero-filled**: loop the retained tail under a decay
  (`PLAYBACK_CONCEAL_FADE_MS`). A hard zero is an audible discontinuity.
- **Underruns are reported in WebRTC's counter shape** on each turn's `stop`
  (`concealedSamples`, `silentConcealedSamples` ⊂ it, `concealmentEvents`,
  `silentConcealmentEvents`) → `VoiceIOOptions.onPlaybackStats`. It is the only
  underrun signal (the session still reads `"speaking"`), so it is the only
  honest basis for retuning. A high silent share means bandwidth, not tuning.
- **`stop` echoes the turn id its `done` named**, and `audio.ts` settles only the
  matching wait: a real drain-stop in flight when a barge-in flushes belongs to
  a turn the host has moved past. The host-side half (turn epoch on `ConnState`)
  is in `../CLAUDE.md`, "Drain completion outlives the turn".

## Capture (`capture-processor.ts`)

- **Its own AudioContext at the STT rate; the worklet converts no rates.** The
  browser's resampler is band-limited; linear interpolation aliases. Playback
  has a separate context at the TTS rate (one context when rates match). There
  is deliberately **no fallback resampler**: `audio.ts` asserts the browser
  honoured both rates and fails init otherwise.
- **Flush a `slice()` copy and keep its own buffer** — re-reading a
  just-transferred view is how a mic goes permanently deaf. Start/stop gating,
  and a stop → flush → `stopped`-ack protocol.
- **Raw voice except echo cancellation.** Both `getUserMedia` call sites (the
  WebSocket mic and `createPttRecorder`) share `VOICE_CAPTURE_CONSTRAINTS`
  (`types.ts`, re-exported on `/internal`) — never a copy. AGC, noise
  suppression and voice isolation are OFF (they rewrite the signal before STT
  and can gate a quiet room to exact zeros, indistinguishable from a dead mic);
  `echoCancellation` stays ON because the mic is open while the agent speaks.
- **Dead-mic probe, once per session**: watch the first `MIC_SILENCE_PROBE_MS`
  for any nonzero sample, report once via `VoiceIOOptions.onMicSilent`, disarm
  on the first real sample so it cannot fire mid-session.

## Tests

- `_worklet-test-utils.ts`'s `instantiateWorklet` honours the transfer list
  (`structuredClone` with `transfer`, which really detaches) and caps posted
  messages so a runaway loop fails by name instead of hanging. Keep both.
- `audio-stress.test.ts` is the worklets' property harness — the same rules as
  the session fuzzers in `../CLAUDE.md`, "Fuzz harnesses".
