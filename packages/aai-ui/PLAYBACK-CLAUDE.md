# packages/aai-ui — playback tuning (sibling of `CLAUDE.md`)

A SIBLING of this package's guide rather than a second one — the shape
`AGENTS.md` describes under "Package guides": Claude Code auto-loads only
`CLAUDE.md`, so this is read on demand, which is the right shape for the
MEASUREMENTS behind two constants and the wrong one for a rule someone needs
resident. It moved here when `CLAUDE.md` reached the 120,000-character cap with
three hundred characters to spare. Nothing was cut; the section is below as it
stood, and `CLAUDE.md` keeps a pointer under the same heading.

## Tuning playback against a REAL reply, not a generated one

`worklets/playback-tuning.test.ts` is where `PLAYBACK_JITTER_MS` and
`PLAYBACK_REFILL_MS` are answered with numbers. It exists because every other
test of the playback worklet supplies its own arrival timing — and
`audio-stress.test.ts` says so in its own header: its chunk sizes outrun the
render loop by an order of magnitude, so "the buffer effectively never starves".
Both are the right tests for what they check, and neither can price a jitter
buffer.

`fixtures/tts-reply-24k.{json,pcm}` is 8 seconds of one real AssemblyAI reply —
the PCM16 bytes plus the millisecond each frame ARRIVED. The `.pcm` is a sidecar
rather than base64 in the JSON so it stays `ffplay`-able and reviewable by its
length; `pcm` is in `KNOWN_BINARY` in `scripts/_ratchet.mjs` for that reason.
Three harnesses sit behind it, all excluded from coverage by the
`_*-harness.ts` glob:

| Harness | Job |
| --- | --- |
| `_tts-trace-harness.ts` | capture (`captureTtsTrace`, needs a live key, takes an INJECTED opener because `resolveTts` is on no published subpath) and replay (`readTtsTraceSync`, keyless and offline) |
| `_playback-bench-harness.ts` | provider frames -> pacer model -> network profile -> the real worklet, on a virtual sample clock. ~3 ms per 17-second render, so a sweep of hundreds of settings is instant and byte-identical every run |
| `_playback-bench-page.ts` | the same thing in a real browser: a real `AudioContext` at the trace's rate, the real worklet, audible output, sliders, and a tap node that captures exactly what reached the destination |

**The browser half is not decoration — it is what makes the offline sweep
believable.** Cross-checked over four link profiles x three settings, concealed
milliseconds agreed within 1-9% and episode counts agreed exactly on eleven of
twelve cells. Where they disagree, the browser is right.

**One fidelity gap, stated because it cannot be closed from here:** the server's
pacer is MODELLED (`pacedSends`). `createAudioPacer` is not on a published
subpath and this package may not import a sibling's internals, so a change to
the real pacer will not fail this file. Re-read it against `pacedSends` if the
pacer moves; exporting the real one and deleting the model is the fix.

### What the measurements say

Recorded against the trace above, the shipped pacing (`CLIENT_AUDIO_LEAD_MS`
1000, `PACER_BURST_MS` 200) and a typical link:

- **TTS synthesizes ~20x faster than it plays** — 4.2 s of speech in 208 ms,
  32.7 s in 1434 ms, first frame at 52-92 ms. So the provider contributes no
  jitter at all, and the arrival pattern the client sees is manufactured
  entirely by the server's pacer.
- **The client's buffer holds ~870 ms mid-reply** (a sawtooth 827-923 ms), never
  anything near the 400 ms fill target. The operative cushion is
  `CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS`. - **Stall resilience is ~867 ms and
  is FLAT in `PLAYBACK_JITTER_MS`** — 859 ms at 100, 906 ms at 800. It tracks
  the pacer's lead almost one-for-one instead (lead 400 -> 250 ms absorbed,
  1000 -> 875 ms, 2000 -> 1844 ms).
- **The whole legal range of `PLAYBACK_JITTER_MS` costs 37 ms of startup**
  (149 ms at 100, 187 ms at 800), because the audio to fill it with has already
  arrived. Its doc's trade — startup for resilience — is real in the abstract
  and worth tens of milliseconds on both sides at these values.
- **The one profile where the fill target earns its keep is a link under the PCM
  bitrate** (350 kbps against the 384 kbps 24 kHz PCM16 needs), and there it
  points the other way: deeper is strictly better, 4 concealment episodes at 100
  against 0 at 800.
- **`PLAYBACK_REFILL_MS` is inert on a stall** (identical output from 50 to 600)
  and decides stutter-versus-pause only under sustained starvation, which is
  exactly the failure the re-arm was added for: at 25 ms the reply degrades into
  hundreds of fragments, at 200 ms into a handful of audible pauses.
- **`PACER_BURST_MS` is spent out of the CLIENT's resilience one-for-one** —
  ~100 ms more absorbed stall at 50 than at 200 — a trade neither constant's doc
  prices, since the burst exists to save timer wakeups on the server.

### `PLAYBACK_JITTER_MS` is redundant BY CONSTRUCTION

The strongest result, and it is structural rather than a property of this trace:
**`{jitterMs: 0, refillMs: R}` renders byte-identically to `{jitterMs: R,
refillMs: R}`** — same startup, same concealed samples, same episode count, on a
healthy link, a 900 ms-jitter link and a starved one alike.

On a turn's FIRST render the ring is empty, so `avail` (0) is under one quantum
and the underrun branch fires before any audio exists — setting `fillTarget =
refillSamples`. Every turn therefore waits for the REFILL target regardless of
what the jitter target said, and `PLAYBACK_JITTER_MS` can only act by being
LARGER. Its entire effect is to make a turn's first wait longer than every later
recovery's, which is the opposite of the argument the refill step rests on (mid
-reply a long wait is itself a hole in the speech).

Collapsing to one target at today's `PLAYBACK_REFILL_MS` (200) is strictly
better than the shipped pair on every link that can carry the bitrate —
startup drops 16 ms on a typical link, 54 ms on mobile, 118 ms at 400 ms of
jitter and 208 ms at 900 ms, with concealment unchanged at zero — and behaves
the same under starvation. Collapsing BELOW 200 is what must not happen: at 50
ms the reply degrades into 99 fragments, which is the stutter the re-arm
exists to prevent.

### The pacer is a cost to playback, not a contributor

Measured across leads including no pacing at all, **startup is 155 ms at every
one of them** — the fill target is met by the first frames either way. Everything
the pacer does to the audio is subtraction:

| lead / burst | absorbs a freeze of | peak in flight | ear behind forwarded |
| --- | --- | --- | --- |
| 1000 / 200 (shipped) | 820 ms | 46 KiB | 848 ms |
| 1000 / 100 | 914 ms | 46 KiB | 955 ms |
| 1500 / 100 | 1453 ms | 68 KiB | 1456 ms |
| 2000 / 100 | 1945 ms | 93 KiB | 1947 ms |
| unpaced | the whole reply | 354 KiB | 4149 ms |

So the pacer earns its keep on backpressure (`MAX_CLIENT_WS_BUFFERED_BYTES` is
4 MiB, so even unpaced this reply is nowhere near it — the guard is for a genuinely
slow link) and on heard-cursor accuracy, NOT on audio. Its `burstMs` is the cheap
win: it is spent out of the client's cushion one-for-one, and the wakeup rate it
was sized against ("~50/second") is ~12.5/second at this provider's 3840-byte
frames.

**The last column is NOT why the lead cannot be raised**, and believing it was
cost this branch a second commit. `HEARD_AUDIO_LAG_MS` (originally 750) was
documented as `PLAYBACK_JITTER_MS` (400) plus a sub-second network hop, and the
measurement above refutes that decomposition: the cushion the client holds is
the pacer's LEAD, moving one-for-one with it and barely at all with the fill
target. The tempting conclusion — derive the ear-lag from the lead — is ALSO
wrong, and was briefly shipped.

**Why: the playback clock already subtracts the buffer.** `heardMs()` in
`aai/host/transports/pipeline-heard.ts` is
`audioMs - clock.remainingMs() - lagMs`, and `endsAtMs` inside that clock
accumulates from `max(endsAtMs, now())` — so it runs ahead by whatever the lead
is, and `remainingMs()` already reports the client's unplayed backlog. Anything
the constant adds on top double-counts it. Driving the host's own arithmetic
against the audio the ear really received (`heardErrorMs` in the test):

| `lagMs` | perfect | typical | mobile |
| --- | --- | --- | --- |
| 0 | +8 ms | +55 ms | +130 ms |
| 150 (shipped) | -142 ms | -95 ms | -20 ms |
| 750 (the old value) | -742 ms | -694 ms | -619 ms |
| 950 (`lead - burst/2`) | -942 ms | -894 ms | -819 ms |

Positive means the cursor runs AHEAD of the ear — over-keeping, the failure
`pipeline-heard.ts` names. At zero it is already accurate to tens of
milliseconds, and the error is IDENTICAL at leads of 1000, 1500 and 2000, which
is the evidence that what is left for the term is the one-way network hop and
nothing else. The old 750 left the cursor ~694 ms early on a typical link — ~10
words at English narration rates rather than the "word or two of redundancy" the
asymmetry argument budgets for, pushing toward exactly the repetition
`buildTailResumePrompt` exists to fix.

**`PIPELINE_PLAYBACK_GRACE_MS` (750) is likewise fine and likewise
lead-independent.** The requirement — how long after `endsAtMs` the caller is
still hearing audio, so a smaller value misses a tail barge-in — measures 15 ms
on a loopback link, 63 ms typical, 138 ms mobile, identical at every lead. It has
~5x margin over the worst of those.

The rule this leaves behind, since two derivations broke on it: **neither
constant is the client's buffer depth.** Measure `heardMs()` against the ear, not
the buffer against the lead.

### What was changed, and what deliberately was not

Three of those findings were acted on; the tests above are what keep them true.

- **`PLAYBACK_JITTER_MS` is deleted**, and with it the worklet's `fillTarget`
  indirection — with one target, that field was always equal to `fillSamples`.
  The survivor is `PLAYBACK_FILL_MS` (200), initialized EXPLICITLY rather than
  left to the pre-roll underrun that used to arm it, so the wait no longer
  depends on whether a write happened to land before the first render callback.
- **`PACER_BURST_MS` is 100**, up from a 200 that cost ~94 ms of absorbed freeze
  for four timer fires a second.
- **`HEARD_AUDIO_LAG_MS` is 150**, down from 750, because it covers only the
  residual the playback clock cannot see — the one-way network hop. It and
  `PIPELINE_PLAYBACK_GRACE_MS` live in `aai/sdk/playback-timing-constants.ts`,
  which exists to keep the trap they share in one place.
- **`CLIENT_AUDIO_LEAD_MS` is 1500**, up from 1000: the longest absorbed link
  freeze goes 914 ms -> 1453 ms at no latency cost. What bounds it is bandwidth
  rather than correctness — a mid-reply barge-in discards ~1.3 s of pushed speech
  instead of ~0.85 s, paid on the metered links that can least afford it.

**The bench grew a barge-in instrument to settle that**, because the claim that
the grace blocked the lead was arithmetic rather than measurement, and wrong.
`playoutVsHost` (in `_playback-bench-host.ts`) replays a render against the
host's own playback-clock arithmetic and reports how long after its estimate the
ear was still receiving audio, for a client that reports its backlog and one that
does not. That is what turned "the grace is ~200 ms short" into "the requirement
is 15-138 ms and the grace has 5x margin", and it is what unblocked the lead.

**The pacer itself stays.** Removing it is the best thing that could happen to
playback quality in isolation — unpaced, the client rides out any freeze — and
it is still wrong on three counts, two of which are measured here: the peak
client-socket queue becomes the whole undelivered reply (356 KiB for 8 s, ~2.7
MiB extrapolated to 60 s, against a 4 MiB disconnect), a mid-reply barge-in
throws away ~3.9 s of pushed speech instead of ~0.85 s, and the ear-lag becomes
proportional to reply length, which no constant or formula can model. Note also
that on a link which cannot carry 384 kbps the pacer changes nothing at all
(identical episode and silence counts at 350 and 250 kbps) — the link is
already the pacer. Its cost is paid on good links and its protection earned on
bad ones, which is coherent.
