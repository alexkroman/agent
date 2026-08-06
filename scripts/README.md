# Scripts

## S2S Load Test

Drives realistic S2S voice sessions with TTS audio, tool calling, barge-in
simulation, connection retries, and network chaos via Toxiproxy.

### Prerequisites

```sh
brew install toxiproxy
```

The script automatically starts and stops `toxiproxy-server`.

### Usage

```sh
# Default launch-day simulation (5000 sessions, 2500 concurrent)
npx tsx scripts/s2s-load-test.ts

# Quick smoke test
npx tsx scripts/s2s-load-test.ts -n 2 -c 2 --rampMs 0 -v

# See all options
npx tsx scripts/s2s-load-test.ts --help
```

Requires `$ASSEMBLYAI_API_KEY` environment variable.

### Toxiproxy

Toxiproxy adds realistic network conditions to every session. Configurable via:

- `--toxicLatency` / `--toxicJitter` — added latency (default: 50ms +/- 20ms)
- `--toxicBandwidth` — bandwidth limit in KB/s (default: unlimited)
- `--toxicReset` — connection reset probability (default: 2.5%)

## Platform WebSocket Load Test

Drives end-to-end sessions against any AAI platform WebSocket URL
(`wss://host/<slug>/websocket`). Measures connect latency, first-audio turn
latency (p50/p95/p99), tool-call counts, and error distribution. Uses the
same Kokoro TTS audio generation and worker-pool approach as the S2S test;
no Toxiproxy dependency.

### Quick start

```sh
# Smoke test (1 session, verbose)
npx tsx scripts/platform-ws-load-test.ts \
  --url wss://my-host/my-agent/websocket -n 1 -v

# Sustained load (100 sessions, 25 concurrent)
npx tsx scripts/platform-ws-load-test.ts \
  --url wss://my-host/my-agent/websocket -n 100 -c 25

# See all options
npx tsx scripts/platform-ws-load-test.ts --help
```

No environment variables required (API key is handled by the platform).

## Voice Replay (τ-voice interaction panel)

`scripts/voice-replay/` measures the **interaction-quality panel** — response
and yield latency, response and yield rate, and the three selectivity rates
(backchannel / vocal tic / non-directed speech) — against a **real** pipeline
agent, by replaying caller audio recorded by
[tau2-bench](https://github.com/sierra-research/tau2-bench).

It exists because a full tau2 run costs 25 LLM+TTS conversations and confounds
task success with turn-taking, while the interaction panel is decided almost
entirely by the STT → barge-in path. Replaying the caller's recorded audio
exercises that path faithfully at a fraction of the cost, and scores it with
**tau2's own metric code**, so the numbers are directly comparable to a
benchmark run.

### How it works

- The caller track is the **left** channel of a sim's archived `both.wav` (the
  agent is on the right and is exactly silent during caller turns), so the
  split is clean and keeps the benchmark's street noise, muffling, injected
  vocal tics and non-directed speech.
- The **user half** of the tick stream is reused verbatim from the original
  simulation, so backchannel/tic/non-directed annotations are ground truth.
  Only the **agent half** is re-measured.
- The run records the raw audio-arrival and wire-event timeline, then
  simulates tick-quantized playout **offline** — so one real run can be scored
  under several client truncation policies (`--policies`) instead of one run
  each.

Open-loop caveat: the caller is a recording and does not adapt to what the
agent says. That makes conditions comparable to each other; it does **not**
reproduce task success (reward / pass^1), which still needs a real tau2 run.

### Usage

```sh
# 1. Boot a real pipeline agent with host mode enabled. Every turn-taking
#    knob is a LAB_* env var, so A/B runs need no code edits.
ASSEMBLYAI_API_KEY=… ANTHROPIC_API_KEY=… \
  node --conditions=@dev/source scripts/voice-replay/agent-server.mjs

# 2. Replay the 10 sims richest in selectivity events against it.
#    Runs inside tau2-bench's env, which owns the metric code.
cd ~/Code/tau2-bench && TAU2_RUN_DIR=data/simulations/<run> \
  uv run python ~/Code/aai/agent/scripts/voice-replay/replay.py \
    --top-n 10 --concurrency 4 --label baseline
```

Tunables on the server (defaults match the shipped agent):
`LAB_MIN_TURN_SILENCE_MS`, `LAB_MAX_TURN_SILENCE_MS`,
`LAB_MIN_BARGE_IN_WORDS`, `LAB_INTERRUPTION_MIN_DURATION_MS`,
`LAB_FALSE_INTERRUPTION_TIMEOUT_MS`, `LAB_VOICE_FOCUS_THRESHOLD`, `LAB_LLM`.

### Sweeping parameters

```sh
# Reboots the agent per condition and replays the same audio through each.
# ~7 min per condition at 25-way concurrency (measured: 0 provider errors).
TAU2_DIR=~/Code/tau2-bench scripts/voice-replay/sweep.sh \
  data/simulations/<run> tmp/sweep

# Compare conditions, with the event count behind every rate.
cd ~/Code/tau2-bench && uv run python \
  ~/Code/aai/agent/scripts/voice-replay/report.py tmp/sweep/*.json
```

**Read the sweep as a frontier, not a leaderboard.** The barge-in knobs trade
R_Y against S_VT/S_ND because one predicate decides both: a gate strict enough
to ignore "hold on a second" is also slow to yield to a real interruption.

**And mind the power — the measured noise floor is much wider than binomial.**
These signals are sparse (about 7 backchannels, 38 vocal tics and 25
non-directed events per 25-conversation run), and `report.py`'s binomial
1-sigma treats the event count as the only source of variance. It is not: the
LLM is nondeterministic, so each run is a *different conversation*, which
changes how much the agent says and therefore how much of it overlaps the
recorded caller.

Measured directly, from **seven runs of a byte-identical configuration against
one server process**:

| metric | mean | sd | observed range | a real difference must clear |
| --- | ---: | ---: | ---: | ---: |
| R_Y | 49.0% | 5.9 | 41.8–57.3 | ~12 pts |
| S_ND | 59.6% | 5.3 | 52.2–65.2 | ~11 pts |
| S_VT | 67.9% | 4.7 | 60.5–75.0 | ~9 pts |
| L_R | 4.3 s | 0.1 | 4.18–4.48 | ~0.2 s |

So a single-run gap of 15 points on R_Y is **within** the noise of changing
nothing at all. Budget several runs per condition, or use paired designs, and
confirm any winner on a second archived run.

**This harness cannot see task success.** It measures turn-taking only, so a
setting that improves the panel may still hurt reward — `min_turn_silence` is
the known example (1600→1000 held the panel roughly flat while DB reward fell
1.00→0.40, because authentication was being transcribed from truncated
spelled-out names). Confirm any endpointing change with a real tau2 run before
believing it.

Requires `$ASSEMBLYAI_API_KEY` and `$ANTHROPIC_API_KEY`, plus a local
tau2-bench checkout with archived run artifacts.

## Voice Agent API replay (S2S counterpart)

`scripts/voice-replay/vaapi_replay.py` replays the same archived caller audio
against **AssemblyAI's Voice Agent API directly — no AAI SDK in the path** —
and, with `--target aai-host`, through our own host-mode server with identical
audio and pacing. A divergence between the two arms therefore localises to our
stack rather than to the service, which is what the harness above cannot tell
you (it only drives the pipeline transport).

Tools execute for real against a fresh copy of the domain's database, so tool
arguments are worth reading. It reports what the service *heard* (word recall
against `user_labels.txt`, utterances heard, partial/final counts) plus reply
completion and the tool calls with their arguments.

```sh
cd ~/Code/tau2-bench                     # owns the domains and the archived runs

# Bare API.
uv run python ~/Code/aai/agent/scripts/voice-replay/vaapi_replay.py \
  --run retail-stt-voice-api-948 --task 0 --prompt sdk --builtins

# Same audio and pacing through our host-mode server, for the A/B.
uv run python ~/Code/aai/agent/scripts/voice-replay/vaapi_replay.py \
  --run retail-stt-voice-api-948 --task 0 --prompt tau2 \
  --target aai-host --host-url "ws://localhost:3002/websocket?host=1"
```

`--prompt sdk --builtins` reproduces the SDK's prompt scaffolding and tool
surface so the bare arm differs from ours in the wire layer ONLY; under
`--target aai-host` pass `--prompt tau2` instead, because the SDK adds that
scaffolding itself. Other levers: `--encoding pcmu` (tau2's native 8 kHz mu-law,
no resampling — the API accepts it and the docs recommend it for telephony),
`--pace-from-log` (deliver at the original run's measured tick rate rather than
real time, reproducing the harness's sub-real-time stalls), and the transcription
knobs `--languages / --keyterms / --transcription-prompt / --voice-focus-threshold`.

**`--target aai-host` reads the SDK from `packages/aai/dist`** — the CLI does not
set the `@dev/source` condition — so rebuild `packages/aai` first or you replay
the previous build. That mistake is silent.

`scripts/voice-replay/vaapi_delta_probe.py` is a ~40-line probe that dumps raw
frames off the socket, for settling "does the service actually emit this event"
without any parsing layer in the way. It is how the claim that
`transcript.agent.delta` is unimplemented was falsified.

Both are run from the tau2-bench checkout (its `.env` holds the production key
that matches the archived runs; `--sims-root` / `$TAU2_SIMS_ROOT` overrides the
run lookup). Open-loop caveat as above: the recorded caller does not adapt to
this agent, so recall and tool arguments are sound but task outcome is not.
