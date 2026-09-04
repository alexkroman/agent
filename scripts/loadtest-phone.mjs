#!/usr/bin/env node
// Drive `WS /phone` as a CARRIER — the tier nothing else exercises end to end.
//
//   pnpm loadtest:phone --port=4900                  # the stub agent
//   pnpm loadtest:phone --port=4900 --carrier=telnyx --seconds=4
//
// `packages/aai-runtime/src/telephony/` has unit tests for the codecs, the bridge
// and the resampler; what it has never had is a caller. This is one: it sends
// the frames a carrier really sends, in the shapes `carriers.ts` parses, and
// reports what came back.
//
// What it proves that a unit test cannot:
//
//   THE RATES ARE LEARNED, not configured — the bridge reads `sampleRate` and
//   `ttsSampleRate` off the session's own `config` frame and builds two
//   resamplers from them. A probe that gets audible μ-law back has exercised
//   that negotiation; a mocked bridge asserts the arithmetic instead.
//
//   THE FORMAT GATE — an `encoding` that is not μ-law must be refused rather
//   than resampled into noise. `--encoding=audio/l16` asks for that refusal.
//
//   THE OUTBOUND SHAPE — Twilio silently drops a `media` frame with no
//   `streamSid`, which presents as an agent that hears the caller and never
//   speaks. A probe sees the frames; nothing else in the repo does.
//
// It needs the STUB agent (`loadtest-boot.sh stub`): a real STT will not commit
// a transcript for synthesized silence, so against a real agent the probe shows
// the handshake and no reply.
//
// ## What it found on its first run
//
// That telephony did not work at all. The bridge tested the session for a
// `"config"` frame and the runtime emits `session.configured`, so both
// resamplers stayed null — the agent's audio hit the "before the config frame"
// drop and the caller's was discarded silently. A call connected, logged
// "Session ready", and neither end could hear the other. The unit tier could not
// see it because its own fixture minted the frame the bridge was looking for.
//
//   before   0 media out, 0 bytes, 4 greeting frames dropped, 0 samples to STT
//   after    52 media out, 20,800 bytes, 52/52 carrying streamSid, 6 `clear`
//
// Read those `clear` frames as the other half: continuous caller audio makes the
// stub STT commit repeatedly and interrupt the agent, so a run exercises the
// barge-in path `CarrierCodec.clear` exists for — the one that decides whether a
// caller who interrupts is talked over for several seconds.
//
// Global `WebSocket` (Node 22+), so this has no dependencies.

import { valueReader } from "./_args.mjs";

const arg = valueReader(process.argv.slice(2));

const PORT = arg("port", "4900");
const CARRIER = arg("carrier", "twilio");
// `String(...)`: a bare `--url` reads as `true` (see `valueReader`), and this
// is handed straight to `WebSocket`.
const URL_ = String(arg("url", `ws://127.0.0.1:${PORT}/phone?carrier=${CARRIER}`));
const SECONDS = Number(arg("seconds", "6"));
const ENCODING = arg("encoding", "audio/x-mulaw");
const STREAM_ID = "MZ00000000000000000000000000000001";

/** 20ms of 8 kHz μ-law — what a carrier sends, every 20ms. */
const FRAME_SAMPLES = 160;
/** μ-law silence. 0xFF is the encoding's zero, not 0x00. */
const SILENCE = Buffer.alloc(FRAME_SAMPLES, 0xff).toString("base64");

const t0 = performance.now();
const at = () => Number((performance.now() - t0).toFixed(1));
const seen = [];
const counts = { mediaOut: 0, clear: 0, other: 0 };
let mediaBytesOut = 0;
let sawStreamId = 0;
let missingStreamId = 0;

const ws = new WebSocket(URL_);

function done(why) {
  console.log(
    JSON.stringify(
      {
        url: URL_,
        why,
        ms: at(),
        sent: { encoding: ENCODING, seconds: SECONDS },
        got: {
          ...counts,
          mediaBytesOut,
          // The Twilio trap, counted rather than assumed.
          mediaWithStreamId: sawStreamId,
          mediaWithoutStreamId: missingStreamId,
        },
        frames: seen.slice(0, 24),
      },
      null,
      2,
    ),
  );
  try {
    ws.close();
  } catch {
    // Already gone; the report is what matters.
  }
  process.exit(0);
}

ws.addEventListener("open", () => {
  seen.push({ at: at(), dir: "open" });
  // The `start` frame, with the id repeated at the top level the way both
  // carriers put it — `carriers.ts` reads either place.
  ws.send(
    JSON.stringify({
      event: "start",
      streamSid: STREAM_ID,
      stream_id: STREAM_ID,
      start: {
        streamSid: STREAM_ID,
        stream_id: STREAM_ID,
        mediaFormat: { encoding: ENCODING, sampleRate: 8000 },
        media_format: { encoding: ENCODING, sample_rate: 8000 },
      },
    }),
  );
  // Then talk: one 20ms frame every 20ms, which is the cadence the pacing on
  // the other side is written against. Sending them all at once would measure
  // the buffer instead.
  let sentFrames = 0;
  const total = Math.round((SECONDS * 1000) / 20);
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || sentFrames >= total) {
      clearInterval(timer);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: "stop" }));
      setTimeout(() => done("sent everything"), 500);
      return;
    }
    sentFrames += 1;
    ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: SILENCE } }));
  }, 20);
});

ws.addEventListener("message", (event) => {
  if (typeof event.data !== "string") {
    seen.push({ at: at(), dir: "in", binary: true });
    return;
  }
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    seen.push({ at: at(), dir: "in", raw: event.data.slice(0, 120) });
    return;
  }
  if (frame.event === "media") {
    counts.mediaOut += 1;
    const payload = frame.media?.payload ?? "";
    mediaBytesOut += Buffer.from(String(payload), "base64").length;
    if (frame.streamSid === STREAM_ID || frame.stream_id === STREAM_ID) sawStreamId += 1;
    else missingStreamId += 1;
    // One line per 50 frames: a reply is hundreds of them.
    if (counts.mediaOut % 50 === 1)
      seen.push({ at: at(), dir: "in", event: "media", n: counts.mediaOut });
    return;
  }
  if (frame.event === "clear") {
    counts.clear += 1;
    seen.push({ at: at(), dir: "in", event: "clear" });
    return;
  }
  counts.other += 1;
  seen.push({
    at: at(),
    dir: "in",
    event: frame.event ?? "?",
    frame: JSON.stringify(frame).slice(0, 160),
  });
});

ws.addEventListener("close", (event) => done(`closed ${event.code}`));
ws.addEventListener("error", () => done("socket error"));
setTimeout(() => done("timeout"), (SECONDS + 15) * 1000);
