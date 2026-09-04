#!/usr/bin/env node
// Drive ONE voice session by hand and print everything the server did — the
// diagnostic half of the load harness (`scripts/loadtest.mjs` is the load half).
//
//   pnpm loadtest:probe --port=4110              # handshake only
//   pnpm loadtest:probe --port=4900 --speak      # one full turn (stub agent)
//   pnpm loadtest:probe --url=ws://host/websocket --speak=3
//
// It exists because a load number is unreadable without knowing which frames a
// session actually got. Two things it reports that no aggregate can:
//
//   PHASES — tcp connect, then the HTTP 101, then the first frame, as three
//   separate numbers. That split is what identified the `aai dev` Vite proxy
//   stall: connect and upgrade were instant and `session.configured` was
//   seconds late, which located the cost in the proxy's own dial rather than
//   anywhere in the agent (see `packages/aai-cli/src/_dev-vite-config.ts`).
//
//   EVERY FRAME, in order, with its arrival time — including the `error.reported`
//   a browser shows as "Session failed to start" and nothing else. A missing
//   session-state table looked exactly like that.
//
// `--speak` needs an agent whose STT commits from the client's own audio, which
// no real provider will do for silence: use the stub agent
// (`loadtest-boot.sh stub`). Against a real agent the audio is ignored and the
// probe times out having seen the handshake, which is still the useful half.
//
// Global `WebSocket` (Node 22+), so this has no dependencies and runs anywhere.

import { valueReader } from "./_args.mjs";

const arg = valueReader(process.argv.slice(2));

const PORT = arg("port", "4110");
const URL_ = arg("url", `ws://127.0.0.1:${PORT}/websocket`);
const SPEAK = arg("speak", false);
const TURNS = SPEAK === true ? 1 : Number(SPEAK || 0);
const TIMEOUT_MS = Number(arg("timeout", "20")) * 1000;

/** 20ms of 16 kHz PCM16, and how many of them the stub STT needs to commit. */
const FRAME_SAMPLES = 320;
const FRAMES_PER_UTTERANCE = 26;

/**
 * `{a: 1, b: undefined}` -> `{a: 1}`.
 *
 * `omitUndefined` from `@alexkroman1/aai/utils`, inlined because this harness
 * deliberately has no dependencies (see the header). It keeps `""`, which the
 * truthiness test it replaced dropped — and that matters here: a
 * `user-transcript.updated` with `text: ""` means speech detected with no words
 * yet, which is a protocol distinction a probe should show rather than hide.
 */
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

const t0 = performance.now();
const at = () => Number((performance.now() - t0).toFixed(1));
const frames = [];
const phases = {};
let audioFramesIn = 0;
let repliesSeen = 0;

const ws = new WebSocket(URL_);
ws.binaryType = "arraybuffer";

function done(why, code) {
  console.log(
    JSON.stringify(
      {
        url: URL_,
        why,
        ...defined({ closeCode: code }),
        ms: at(),
        phases,
        audioFramesIn,
        frames,
      },
      null,
      2,
    ),
  );
  try {
    ws.close();
  } catch {
    // Already closed — nothing to report about a socket we are done with.
  }
  process.exit(0);
}

/** Send one utterance's worth of audio, which is what makes the stub commit. */
function speak() {
  const frame = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAMES_PER_UTTERANCE; i++) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(frame.buffer.slice(0));
  }
  frames.push({ at: at(), dir: "out", audioFrames: FRAMES_PER_UTTERANCE });
}

ws.addEventListener("open", () => {
  // `open` fires on the 101, so this is connect + upgrade together — the split
  // between them is not observable from the WebSocket API and is not worth a
  // raw socket to get: what mattered in the Vite case was upgrade vs FIRST
  // FRAME, and that is the pair below.
  phases.upgradeMs = at();
  frames.push({ at: at(), dir: "open" });
  ws.send(JSON.stringify({ type: "start", sampleRate: 16_000 }));
});

ws.addEventListener("message", (event) => {
  if (typeof event.data !== "string") {
    audioFramesIn += 1;
    return;
  }
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    frames.push({ at: at(), dir: "in", raw: event.data.slice(0, 200) });
    return;
  }
  phases.firstFrameMs ??= at();
  frames.push({
    at: at(),
    dir: "in",
    type: frame.type,
    ...defined({
      code: frame.code,
      message: frame.message === undefined ? undefined : String(frame.message).slice(0, 160),
      text: frame.text === undefined ? undefined : String(frame.text).slice(0, 80),
    }),
  });

  if (frame.type === "session.configured") {
    phases.configuredMs = at();
    if (TURNS > 0) speak();
    return;
  }
  // A fatal error ends the session server-side; waiting out the timeout after
  // one only delays the report.
  if (frame.type === "error.reported" && frame.fatal) done(`fatal ${frame.code}`);
  if (frame.type === "reply.completed") {
    repliesSeen += 1;
    // The GREETING is a reply too, so the first completion is not a turn: the
    // count is replies past it. Reading it as a turn is how a first draft
    // reported a turn nobody drove.
    if (repliesSeen > TURNS) return done("turns complete");
    if (TURNS > 0) speak();
  }
});

ws.addEventListener("close", (event) => done("closed", event.code));
ws.addEventListener("error", () => done("socket error"));
setTimeout(() => done("timeout"), TIMEOUT_MS);
