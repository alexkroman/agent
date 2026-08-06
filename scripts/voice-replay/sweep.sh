#!/usr/bin/env bash
# Sweep pipeline turn-taking parameters against the replay harness.
#
# Each condition reboots agent-server.mjs with a different LAB_* environment
# and replays the same caller audio through it, so conditions differ only in
# the knob under test. Results land as <outdir>/<name>.json; compare them with
# report.py.
#
# The knobs worth sweeping trade against each other rather than improving
# monotonically — a stricter barge-in gate raises selectivity (S_VT/S_ND) and
# lowers yield rate (R_Y), because both are decided by the same predicate. So
# this prints a frontier, not a winner; pick from it with report.py.
#
# Usage:
#   scripts/voice-replay/sweep.sh <tau2-run-dir> <outdir> [grid-file]
#
# A grid file is one condition per line: "name KEY=VAL KEY=VAL ...".
# Without one, the built-in barge-in grid below is used.
set -euo pipefail

RUN_DIR="${1:?usage: sweep.sh <tau2-run-dir> <outdir> [grid-file]}"
OUT_DIR="${2:?usage: sweep.sh <tau2-run-dir> <outdir> [grid-file]}"
GRID_FILE="${3:-}"

# Absolute, because replay.py runs with cwd=$TAU2_DIR (it needs tau2's env) and
# would otherwise write results into the tau2 checkout instead of here.
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAU2_DIR="${TAU2_DIR:-$HOME/Code/tau2-bench}"
SIMS="${SWEEP_SIMS:-25}"
CONCURRENCY="${SWEEP_CONCURRENCY:-25}"
PORT="${LAB_PORT:-8791}"

DEFAULT_GRID=$(cat <<'EOF'
default          LAB_MIN_BARGE_IN_WORDS=2 LAB_INTERRUPTION_MIN_DURATION_MS=500
words3           LAB_MIN_BARGE_IN_WORDS=3 LAB_INTERRUPTION_MIN_DURATION_MS=500
words4           LAB_MIN_BARGE_IN_WORDS=4 LAB_INTERRUPTION_MIN_DURATION_MS=500
words4-dur250    LAB_MIN_BARGE_IN_WORDS=4 LAB_INTERRUPTION_MIN_DURATION_MS=250
words5-dur250    LAB_MIN_BARGE_IN_WORDS=5 LAB_INTERRUPTION_MIN_DURATION_MS=250
haiku            LAB_MIN_BARGE_IN_WORDS=2 LAB_INTERRUPTION_MIN_DURATION_MS=500 LAB_LLM=claude-haiku-4-5-20251001
EOF
)

SERVER_PID=""
stop_server() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}
trap stop_server EXIT

run_condition() {
  local name="$1"; shift
  echo "=== condition: $name  ($*)"

  # LAB_*=value tokens configure the server; --flag/value tokens are passed
  # through to replay.py (prompt variants, pacing) and need no reboot.
  local -a SERVER_ENV=() REPLAY_FLAGS=()
  local tok
  for tok in "$@"; do
    case "$tok" in
      LAB_*=*) SERVER_ENV+=("$tok") ;;
      *) REPLAY_FLAGS+=("$tok") ;;
    esac
  done
  # bash 3.2 (what macOS ships) errors on "${arr[@]}" for an EMPTY array under
  # `set -u`, so both splices are guarded. A prompt-only condition has no
  # LAB_* tokens and a knob-only condition has no --flags; either one would
  # otherwise abort the sweep on expansion rather than on anything real.
  set -- ${SERVER_ENV[@]+"${SERVER_ENV[@]}"}

  local log="$OUT_DIR/$name.server.log"
  stop_server

  # Wait for the PORT to be free, not for /health to fail. Those are different
  # questions and confusing them silently invalidates a whole sweep: the first
  # version of this script killed the server, saw health stop answering, and
  # started the next one — which lost the bind race, died with EADDRINUSE, and
  # left every later condition replaying against the FIRST condition's still
  # running server. Six conditions, one configuration, and metrics that looked
  # plausibly different because LLM nondeterminism alone moves them.
  for _ in $(seq 1 60); do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
  done
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "!! port $PORT still held before $name; aborting sweep"
    return 1
  fi

  # `exec` so $! is the node process itself. Without it $! is the subshell, and
  # killing that leaves node alive holding the port — the bug described above.
  ( cd "$REPO_ROOT" && exec env "$@" LAB_PORT="$PORT" \
      node --conditions=@dev/source scripts/voice-replay/agent-server.mjs \
      > "$log" 2>&1 ) &
  SERVER_PID=$!

  for _ in $(seq 1 60); do
    grep -q '"ready":true' "$log" 2>/dev/null && break
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  if ! grep -q '"ready":true' "$log" 2>/dev/null; then
    echo "!! server failed to start for $name; see $log"
    return 1
  fi

  # ASSERT the live server is running THIS condition's knobs. A sweep whose
  # conditions silently collapse into one is worse than a failed sweep: it
  # yields a full table of numbers that all describe the same configuration.
  local ready; ready="$(grep -m1 '"ready":true' "$log")"
  echo "  $ready"
  local kv k v
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    case "$k" in
      LAB_MIN_BARGE_IN_WORDS) k=minBargeInWords ;;
      LAB_INTERRUPTION_MIN_DURATION_MS) k=interruptionMinDurationMs ;;
      LAB_FALSE_INTERRUPTION_TIMEOUT_MS) k=falseInterruptionTimeoutMs ;;
      LAB_MIN_TURN_SILENCE_MS) k=minTurnSilenceMs ;;
      LAB_MAX_TURN_SILENCE_MS) k=maxTurnSilenceMs ;;
      *) continue ;;
    esac
    if [[ "$ready" != *"\"$k\":$v"* ]]; then
      echo "!! $name: server reports $k != $v — refusing to record a mislabelled run"
      return 1
    fi
  done

  ( cd "$TAU2_DIR" && TAU2_RUN_DIR="$RUN_DIR" uv run python \
      "$REPO_ROOT/scripts/voice-replay/replay.py" \
      --top-n "$SIMS" --concurrency "$CONCURRENCY" \
      --ws "ws://127.0.0.1:$PORT/websocket?host=1" \
      ${REPLAY_FLAGS[@]+"${REPLAY_FLAGS[@]}"} \
      --label "$OUT_DIR/$name" ) 2>&1 | grep -vi "NON-OFFICIAL" || true
}

if [[ -n "$GRID_FILE" ]]; then
  GRID=$(cat "$GRID_FILE")
else
  GRID="$DEFAULT_GRID"
fi

# Replicates are the OUTER loop, conditions the inner one, so the conditions are
# interleaved in time rather than run back to back. Two reasons. The LLM is
# nondeterministic, so a single run per condition cannot separate a knob from
# the conversation it happened to produce (measured: seven identical runs spread
# R_Y over 15.5 points). And this repository is worked on by more than one agent
# at a time — a source edit landing mid-sweep would otherwise fall entirely on
# whichever conditions came after it, which is exactly how an earlier sweep
# attributed another session's pacing change to a barge-in knob. Interleaved,
# such an edit hits every condition about equally and shows up as spread rather
# than as a false winner. `fingerprint` records the source state per run so a
# straddling replicate can be identified and dropped.
fingerprint() {
  (cd "$REPO_ROOT" && cat packages/aai/host/transports/*.ts packages/aai/host/*.ts \
    packages/aai/sdk/*.ts 2>/dev/null | md5 -q 2>/dev/null || echo unknown)
}

REPLICATES="${SWEEP_REPLICATES:-1}"
for rep in $(seq 1 "$REPLICATES"); do
  while read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    # shellcheck disable=SC2086
    set -- $line
    cond="$1"; shift
    label="$cond"
    [[ "$REPLICATES" -gt 1 ]] && label="${cond}__r${rep}"
    echo "--- source fingerprint: $(fingerprint)"
    run_condition "$label" "$@" || echo "!! skipping $label"
  done <<< "$GRID"
done

stop_server
echo "sweep complete -> $OUT_DIR"
