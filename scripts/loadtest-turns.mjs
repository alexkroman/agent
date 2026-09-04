#!/usr/bin/env node
// Sustained TURN load: N long-lived sessions, each taking turns back to back.
//
//   pnpm loadtest:turns --port=4900
//   pnpm loadtest:turns --port=4900 --sessions=40 --duration=30
//
// This is a different measurement from `scripts/loadtest.mjs --scenario=session`,
// and the difference is the point. That one opens a session, waits for
// `session.configured`, and closes — so it measures session SETUP under churn,
// which is what a burst of arrivals costs. This one connects once and then
// exercises the per-turn pipeline (audio in -> STT commit -> LLM stream -> TTS
// -> audio out) for the whole run, which is the shape production actually has:
// a phone line is one session and hundreds of turns.
//
// It NEEDS the stub agent (`loadtest-boot.sh stub`). A real STT will not commit
// a transcript for synthesized silence, so against a real agent no turn ever
// starts and the report is all zeroes with the errors empty — which is a
// correct measurement of nothing. With the stubs, every stage is real code and
// only the three vendors are gone, so what the number describes is the agent.
//
// Closed-loop per session: the next utterance goes out when the last reply
// completed, so latency is measured at a fixed concurrency rather than against
// a backlog the server never agreed to.
//
// Global `WebSocket` (Node 22+), so this has no dependencies.

import { valueReader } from "./_args.mjs";

const arg = valueReader(process.argv.slice(2));

const PORT = arg("port", "4900");
// `String(...)`: a bare `--url` reads as `true` (see `valueReader`), and this
// is handed straight to `WebSocket`.
const URL_ = String(arg("url", `ws://127.0.0.1:${PORT}/websocket`));
const SESSIONS = Number(arg("sessions", "10"));
const DURATION_MS = Number(arg("duration", "12")) * 1000;

/** 20ms of 16 kHz PCM16, and how many the stub STT needs before it commits. */
const FRAME = new Int16Array(320);
const FRAMES_PER_UTTERANCE = 26;

/** How long past the deadline a session waits for its last reply to land. */
const DRAIN_MS = 15_000;

const latencies = [];
const errors = new Map();
let turns = 0;
let audioFramesIn = 0;

const note = (err) => {
  const key = String(err?.message ?? err).slice(0, 60);
  errors.set(key, (errors.get(key) ?? 0) + 1);
};

/**
 * One message as a parsed server frame, or `undefined` for the audio and the
 * unparsable.
 *
 * Its own function so the turn loop below stays under the complexity cap — and
 * because counting inbound audio is bookkeeping rather than part of the loop.
 */
function readFrame(event) {
  if (typeof event.data !== "string") {
    audioFramesIn += 1;
    return;
  }
  try {
    return JSON.parse(event.data);
  } catch {
    // Not JSON: nothing the turn loop can act on. Falls through to undefined.
  }
}

/**
 * One session: connect, let the greeting finish, then loop turns to `deadline`.
 *
 * `@returns` is load-bearing: it is what makes `resolve()` with no argument
 * legal, the promise carrying no value being the point.
 *
 * @returns {Promise<void>}
 */
function runSession(deadline) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_);
    ws.binaryType = "arraybuffer";
    let turnStart = 0;
    let greeted = false;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) note(err);
      try {
        ws.close();
      } catch {
        // Already closed; the run is over either way.
      }
      resolve();
    };

    const speak = () => {
      if (Date.now() >= deadline) return finish();
      turnStart = performance.now();
      for (let i = 0; i < FRAMES_PER_UTTERANCE; i++) {
        if (ws.readyState !== WebSocket.OPEN) return finish();
        ws.send(FRAME.buffer.slice(0));
      }
    };

    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "start", sampleRate: 16_000 })),
    );
    /** What one server frame means for this session's turn loop. */
    const onFrame = (frame) => {
      if (frame.type === "error.reported" && frame.fatal) {
        return finish(new Error(`${frame.code}: ${frame.message}`));
      }
      if (frame.type !== "reply.completed") return;
      // The GREETING is a reply, so the first completion is not a turn — it is
      // the starting gun. Counting it inflates the rate and reports a latency
      // measured from a `turnStart` that was never set.
      if (!greeted) {
        greeted = true;
        return speak();
      }
      turns += 1;
      latencies.push(performance.now() - turnStart);
      speak();
    };

    ws.addEventListener("message", (event) => {
      const frame = readFrame(event);
      if (frame) onFrame(frame);
    });
    ws.addEventListener("close", () => finish());
    ws.addEventListener("error", () => finish(new Error("socket error")));
    setTimeout(() => finish(), DURATION_MS + DRAIN_MS);
  });
}

const started = Date.now();
await Promise.all(Array.from({ length: SESSIONS }, () => runSession(started + DURATION_MS)));
const elapsedMs = Date.now() - started;

const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) =>
  sorted.length > 0
    ? Number(
        sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(1),
      )
    : 0;

console.log(
  JSON.stringify({
    url: URL_,
    sessions: SESSIONS,
    seconds: Number((elapsedMs / 1000).toFixed(1)),
    turns,
    turnsPerSec: Number(((turns / elapsedMs) * 1000).toFixed(1)),
    audioFramesIn,
    turnMs: { p50: pct(50), p90: pct(90), p99: pct(99), max: pct(100) },
    errors: Object.fromEntries(errors),
  }),
);
