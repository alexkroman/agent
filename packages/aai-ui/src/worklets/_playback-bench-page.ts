// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser half of the playback bench: a page that plays a recorded reply
 * through the REAL playback worklet in a REAL `AudioContext`, so the tuning can
 * be listened to rather than only counted.
 *
 * This is the part the offline renderer cannot be: `renderSchedule` drives
 * `process()` on a synthetic sample clock with `postMessage` delivered exactly
 * between quanta, which is the ordering the audio thread guarantees but says
 * nothing about the browser's own render cadence, its output latency, or what
 * a `port.postMessage` burst does to a live audio callback. If the two agree,
 * the offline sweep is trustworthy; where they disagree, the browser is right.
 *
 * Two ways in, same page:
 *
 * - **A human opens it** and gets a slider for `fillMs`, the
 *   network profile, and the pacer lead, with the worklet's own concealment
 *   counters live. Audio comes out of the speakers.
 * - **Playwright drives it** through {@link BENCH_API} on `window`, and pulls
 *   back the samples the tap captured — the audio that actually reached the
 *   destination — so a test can diff it against the offline render.
 *
 * The page is a STRING rather than a file under a bundler because it must stay
 * test-only: aai-ui's build (`tsdown` + `build-default-client.ts`) ships
 * `dist/default-client/`, and a second HTML entry there is a product artifact
 * with a coverage floor and a size budget. Generated into `reports/playback/`,
 * it is neither.
 */

import { playbackProcessorSource } from "./playback-processor.ts";

/** The name of the object the page exposes for a driver to call. */
export const BENCH_API = "__aaiPlaybackBench";

/**
 * A tap that passes audio through and reports every sample it saw.
 *
 * The only way to know what the ear received: the playback worklet's own stats
 * say how much was concealed, not what came out. Batched to ~0.25 s per post
 * because one message per 128-sample quantum is ~190 posts a second off the
 * audio thread, which is itself a source of glitching.
 */
const TAP_WORKLET = `
class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(6144);
    this.n = 0;
    // An explicit end-of-run flush, so the page never has to WAIT OUT the batch
    // window to know it has every sample. A timed wait here would be both a
    // race and a hand-rolled sleep (guard-invariants rule 19), and the audio
    // thread can simply answer.
    this.port.onmessage = (e) => {
      if (e.data && e.data.event === 'drain') {
        this.flush();
        this.port.postMessage({ drained: true });
      }
    };
  }
  flush() {
    if (this.n === 0) return;
    const out = this.batch.slice(0, this.n);
    this.port.postMessage({ samples: out }, [out.buffer]);
    this.n = 0;
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!inp) { this.flush(); return true; }
    if (out) out.set(inp);
    if (this.n + inp.length > this.batch.length) this.flush();
    this.batch.set(inp, this.n);
    this.n += inp.length;
    return true;
  }
}
registerProcessor('tap-processor', TapProcessor);
`;

/** Options a driver or a human can set on one run. */
export type BenchRunOptions = {
  fillMs: number;
  /** Deliveries: ms since run start, and the slice of the PCM to write. */
  schedule: { atMs: number; offset: number; length: number }[];
  /** Whether the reply is audible. A sweep run in a headless browser is not. */
  muted?: boolean;
};

/**
 * Build the bench page.
 *
 * `pcmUrl` is fetched once and sliced per delivery, so the page replays the
 * same bytes the offline renderer does. `sampleRate` must be the trace's: the
 * context is created at it and the page REFUSES to run if the browser grants
 * another, exactly as `audio.ts` does — PCM written into a context at the wrong
 * rate plays at the wrong speed, which would look like a tuning result.
 */
export function benchPageHtml(opts: {
  pcmUrl: string;
  sampleRate: number;
  /** Shown in the header, so a saved page names what it is playing. */
  title: string;
  /** Default schedules a human can pick between, by profile name. */
  profiles: Record<string, { atMs: number; offset: number; length: number }[]>;
  defaults?: { fillMs: number };
}): string {
  const defaults = opts.defaults ?? { fillMs: 200 };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>aai playback bench — ${escapeHtml(opts.title)}</title>
<style>
  body { font: 14px/1.5 ui-monospace, monospace; background: #14110d; color: #f0ebe2; margin: 0; padding: 24px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .sub { opacity: .6; margin-bottom: 20px; }
  fieldset { border: 1px solid #3a352c; margin: 0 0 16px; padding: 12px 16px; }
  legend { opacity: .7; padding: 0 6px; }
  label { display: inline-block; min-width: 110px; }
  input[type=range] { width: 260px; vertical-align: middle; }
  output { display: inline-block; min-width: 70px; }
  button { font: inherit; background: #f0ebe2; color: #14110d; border: 0; padding: 6px 14px; cursor: pointer; }
  button:disabled { opacity: .4; cursor: default; }
  table { border-collapse: collapse; margin-top: 8px; }
  td { padding: 2px 16px 2px 0; }
  td:first-child { opacity: .6; }
  .bar { height: 10px; background: #3a352c; width: 320px; position: relative; }
  .bar > i { position: absolute; inset: 0 auto 0 0; background: #7fb069; }
</style>
</head>
<body>
<h1>aai playback bench</h1>
<div class="sub">${escapeHtml(opts.title)} &middot; ${opts.sampleRate} Hz &middot; the real playback worklet in a real AudioContext</div>

<fieldset><legend>worklet</legend>
  <div><label for="fill">fillMs</label><input id="fill" type="range" min="0" max="900" step="25" value="${defaults.fillMs}"><output id="fillOut">${defaults.fillMs}</output>
    <span class="sub">PLAYBACK_FILL_MS &mdash; the one fill target, at a turn's start and after an underrun</span></div>
</fieldset>

<fieldset><legend>link</legend>
  <div><label for="profile">profile</label><select id="profile"></select>
    <span class="sub">pacer lead + network, precomputed &mdash; each profile is one delivery schedule</span></div>
  <div style="margin-top:8px"><label for="muted">muted</label><input id="muted" type="checkbox"></div>
</fieldset>

<fieldset><legend>run</legend>
  <button id="play">play</button>
  <button id="stop" disabled>stop</button>
  <button id="save" disabled>download what you heard (.wav)</button>
  <table>
    <tr><td>buffered</td><td><div class="bar"><i id="bufBar" style="width:0"></i></div></td><td id="buf">&mdash;</td></tr>
    <tr><td>first audio</td><td id="ttfa">&mdash;</td></tr>
    <tr><td>concealed</td><td id="concealed">&mdash;</td></tr>
    <tr><td>silent</td><td id="silent">&mdash;</td></tr>
    <tr><td>episodes</td><td id="events">&mdash;</td></tr>
    <tr><td>state</td><td id="state">idle</td></tr>
  </table>
</fieldset>

<script type="module">
const SAMPLE_RATE = ${opts.sampleRate};
const PROFILES = ${JSON.stringify(opts.profiles)};
const PLAYBACK_SRC = ${JSON.stringify(playbackProcessorSource)};
const TAP_SRC = ${JSON.stringify(TAP_WORKLET)};

const pcm = new Uint8Array(await (await fetch(${JSON.stringify(opts.pcmUrl)})).arrayBuffer());
const el = (id) => document.getElementById(id);
const sel = el("profile");
for (const name of Object.keys(PROFILES)) {
  const o = document.createElement("option");
  o.value = name; o.textContent = name; sel.append(o);
}
for (const [id, out] of [["fill", "fillOut"]]) {
  el(id).addEventListener("input", () => { el(out).textContent = el(id).value; });
}

let ctx = null;
let running = null;

/** One run. Resolves with the tap's samples and the worklet's own stats. */
async function run(o) {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "playback" });
    if (ctx.sampleRate !== SAMPLE_RATE) {
      throw new Error("browser refused " + SAMPLE_RATE + " Hz, gave " + ctx.sampleRate +
        " — every number this bench produces would be at the wrong speed");
    }
    await ctx.audioWorklet.addModule(blobUrl(PLAYBACK_SRC));
    await ctx.audioWorklet.addModule(blobUrl(TAP_SRC));
  }
  await ctx.resume();

  const node = new AudioWorkletNode(ctx, "playback-processor", {
    processorOptions: { fillMs: o.fillMs },
  });
  const tap = new AudioWorkletNode(ctx, "tap-processor");
  const gain = new GainNode(ctx, { gain: o.muted ? 0 : 1 });
  node.connect(tap).connect(gain).connect(ctx.destination);

  const captured = [];
  let total = 0;
  tap.port.onmessage = (e) => { captured.push(e.data.samples); total += e.data.samples.length; };

  const result = { stats: null, progress: [], startedAt: null, firstAudioMs: null };
  const settled = new Promise((resolve) => {
    node.port.onmessage = (e) => {
      const d = e.data;
      if (d.event === "progress") {
        result.progress.push(d.bufferedMs);
        el("buf").textContent = d.bufferedMs.toFixed(0) + " ms";
        el("bufBar").style.width = Math.min(100, (d.bufferedMs / 1200) * 100) + "%";
        // The first progress report is the first quantum that held audio, which
        // is as close to "the ear got something" as the port can say.
        if (result.firstAudioMs === null) {
          result.firstAudioMs = performance.now() - result.startedAt;
          el("ttfa").textContent = result.firstAudioMs.toFixed(0) + " ms";
        }
      } else if (d.event === "stop") {
        result.stats = d.stats;
        el("concealed").textContent = ms(d.stats.concealedSamples);
        el("silent").textContent = ms(d.stats.silentConcealedSamples);
        el("events").textContent = d.stats.concealmentEvents + " (" + d.stats.silentConcealmentEvents + " to silence)";
        resolve();
      }
    };
  });

  // Deliver on the AUDIO clock, not on setTimeout: the schedule's whole point
  // is where a frame lands relative to playout, and a timer that drifts 15 ms
  // under load would be indistinguishable from the network jitter under test.
  const schedule = o.schedule;
  let next = 0;
  const t0 = ctx.currentTime;
  result.startedAt = performance.now();
  el("state").textContent = "playing";
  const pump = () => {
    const nowMs = (ctx.currentTime - t0) * 1000;
    while (next < schedule.length && schedule[next].atMs <= nowMs) {
      const d = schedule[next++];
      const bytes = pcm.slice(d.offset, d.offset + d.length);
      node.port.postMessage({ event: "write", buffer: bytes }, [bytes.buffer]);
    }
    if (next >= schedule.length) {
      node.port.postMessage({ event: "done", turn: 1 });
      return;
    }
    timer = setTimeout(pump, 2);
  };
  let timer = setTimeout(pump, 0);
  running = () => { clearTimeout(timer); node.port.postMessage({ event: "interrupt" }); };

  await settled;
  clearTimeout(timer);
  // The tap batches, so the last partial batch is still held when 'stop' fires.
  // Ask for it rather than waiting a guessed interval.
  await new Promise((resolve) => {
    tap.port.onmessage = (e) => {
      if (e.data && e.data.drained) resolve();
      else if (e.data && e.data.samples) { captured.push(e.data.samples); total += e.data.samples.length; }
    };
    tap.port.postMessage({ event: 'drain' });
  });
  node.disconnect(); tap.disconnect(); gain.disconnect();
  el("state").textContent = "done";
  running = null;

  const samples = new Float32Array(total);
  let w = 0;
  for (const c of captured) { samples.set(c, w); w += c.length; }
  return { ...result, samples };
}

const ms = (n) => ((n / SAMPLE_RATE) * 1000).toFixed(0) + " ms";
const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: "application/javascript" }));

let last = null;
// This listener's ENTIRE body is a try/catch/finally, so it cannot reject and
// guard-invariants rule 23's hazard does not apply. Kept as-is rather than
// inverted into void run().catch(report) because the finally block re-enables the
// buttons and reads better attached to the click that disabled them.
//
// It used to carry a baseline entry against that rule, which was never a real
// occurrence: this whole page is a TEMPLATE LITERAL, and a line-based scan
// matched the text inside it. Rule 23 is a node rule now and a string is not a
// listener, so the entry is gone. The reasoning above is still what makes the
// code right — nothing in this string is checked by that rule any more.
el("play").addEventListener("click", async () => {
  el("play").disabled = true; el("stop").disabled = false; el("save").disabled = true;
  try {
    last = await run({
      fillMs: +el("fill").value,
      schedule: PROFILES[sel.value],
      muted: el("muted").checked,
    });
    el("save").disabled = false;
  } catch (err) {
    el("state").textContent = "error: " + err.message;
  } finally {
    el("play").disabled = false; el("stop").disabled = true;
  }
});
el("stop").addEventListener("click", () => { running?.(); });
el("save").addEventListener("click", () => {
  if (!last) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([wav(last.samples, SAMPLE_RATE)], { type: "audio/wav" }));
  a.download = "heard-fill" + el("fill").value + "-" + sel.value + ".wav";
  a.click();
});

function wav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 0x7fff), true);
  }
  return buf;
}

// The driver surface. run() returns the tap's samples, so a test can diff what
// the browser actually rendered against what the offline renderer predicted.
window[${JSON.stringify(BENCH_API)}] = {
  run: async (o) => {
    const r = await run(o);
    return {
      stats: r.stats,
      progress: r.progress,
      firstAudioMs: r.firstAudioMs,
      // Structured-clone of a Float32Array crosses Playwright's bridge as an
      // object with numeric keys, which is 4 MB of JSON; send the count and
      // let the caller ask for the bytes it needs.
      sampleCount: r.samples.length,
      samples: Array.from(r.samples.subarray(0, Math.min(r.samples.length, 0))),
      _keep: (window.__aaiLastSamples = r.samples) && undefined,
    };
  },
  /** Pull the last run's samples back in slices, as base64 PCM16. */
  slice: (from, count) => {
    const s = window.__aaiLastSamples.subarray(from, from + count);
    const bytes = new Uint8Array(s.length * 2);
    const v = new DataView(bytes.buffer);
    for (let i = 0; i < s.length; i++) {
      v.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, s[i])) * 0x7fff), true);
    }
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  },
  ready: true,
};
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
