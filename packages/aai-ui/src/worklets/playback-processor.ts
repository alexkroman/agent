// Playback worklet: receives raw PCM16 LE bytes, handles byte alignment,
// converts to float32, and plays through a jitter buffer with hysteresis.
//
// The buffer has two states, and ONE fill target. It fills to `fillSamples`
// before a turn starts speaking, and on an underrun it returns to filling —
// to the same target — rather than playing whatever fragment has arrived.
// Without that re-arm the cushion is a one-shot budget: once spent, readPos
// chases writePos for the rest of the turn and every quantum emits a few real
// samples padded with silence, which is heard as stutter through every word
// rather than as one pause. Gaps are covered by extrapolating from played audio
// (see `coverGap`), and every covered sample is counted so a turn can report how
// much of itself was concealed.
//
// There used to be a SECOND, larger target for the start of a turn
// (`PLAYBACK_JITTER_MS`, 400, against this one's 200), and it was redundant by
// construction: on a turn's first render the ring is empty, so `avail` (0) is
// under one quantum and the underrun branch below fires before any audio
// exists — arming the refill target. Every turn already waited for this number,
// so the startup target could only act by being LARGER, which is backwards. It
// is initialized explicitly here rather than left to that pre-roll underrun,
// because relying on the accident would make the wait depend on whether a write
// happened to land before the first render callback. `PLAYBACK_FILL_MS`'s doc
// carries the measurement.

import {
  PLAYBACK_BUFFER_SECONDS,
  PLAYBACK_CONCEAL_FADE_MS,
  PLAYBACK_CONCEAL_FLOOR,
  PLAYBACK_FILL_MS,
  PLAYBACK_PROGRESS_INTERVAL_MS,
} from "../types.ts";
import { workletModuleUrl } from "./_module-url.ts";

/** Raw worklet source — exported so tests can evaluate the processor directly. */
export const playbackProcessorSource = `
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    // The node's context IS the playback context (audio.ts asserts its rate),
    // so the worklet-global sampleRate is authoritative; the option exists
    // for the node-less test harness.
    const rate = opts.sampleRate ?? sampleRate;
    // Kept, because every derived quantity below reads it and \`bufferedMs\` in
    // process() is the one that used to read the worklet global instead. Those
    // agree in production (the option is unset, so \`rate\` IS \`sampleRate\`) and
    // diverge only in the node-less harness — which is the one place a spec
    // could ever assert on the reported backlog, so the divergence made the
    // number untestable rather than wrong.
    this.rate = rate;
    // The one fill target — for the start of a turn and for recovery after an
    // underrun alike. If 'done' arrives first (short utterance), start
    // immediately instead of waiting for audio that is never coming.
    this.fillSamples = Math.floor((rate * (opts.fillMs ?? ${PLAYBACK_FILL_MS})) / 1000);
    // Concealment source: a ring of the most recently played samples, looped
    // under a decaying gain to cover a gap. Sized to the fade window, with a
    // per-sample decay that reaches the floor exactly at its end.
    this.concealCapacity = Math.max(1, Math.floor((rate * ${PLAYBACK_CONCEAL_FADE_MS}) / 1000));
    this.concealBuf = new Float32Array(this.concealCapacity);
    this.concealDecay = Math.exp(Math.log(${PLAYBACK_CONCEAL_FLOOR}) / this.concealCapacity);
    // Float32 ring buffer — PLAYBACK_BUFFER_SECONDS at the context sample
    // rate. Allocated once for the node's lifetime; per-turn state resets via
    // resetTurn(). writePos and readPos are absolute (monotonic) sample
    // counts; the buffer is indexed modulo capacity so a longer reply keeps
    // playing instead of writing past the end and going silent.
    this.capacity = rate * ${PLAYBACK_BUFFER_SECONDS};
    this.samples = new Float32Array(this.capacity);
    // Cadence for the 'progress' report in process(), counted in samples so
    // the hot path never reads a clock. Survives resetTurn(): the host clamps
    // upward only, so a stale count costs at most one extra report.
    this.reportIntervalSamples = Math.floor((rate * ${PLAYBACK_PROGRESS_INTERVAL_MS}) / 1000);
    this.sinceReportSamples = 0;
    // Platform endianness probe: the wire format is PCM16 little-endian, so
    // the Int16Array fast path in ingestBytes is only valid on LE hosts
    // (every shipping browser target; the DataView path is the fallback).
    this.littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    this.resetTurn();

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.event === 'write') {
        this.ingestBytes(d.buffer);
      } else if (d.event === 'interrupt') {
        // Applied eagerly, not deferred to the next process(): onmessage and
        // process() never interleave (one audio thread), and a deferred
        // interrupt would let 'write'/'done' frames for the NEXT turn
        // coalesce in ahead of it and be wiped by the reset along with the
        // cancelled turn's audio.
        this.stopTurn('interrupt');
      } else if (d.event === 'done') {
        this.isDone = true;
        // Echoed back on this turn's 'stop' so the host can tell WHICH turn
        // drained: a stop already in flight when a barge-in lands would
        // otherwise settle the next turn's done() the moment it arrives.
        this.doneTurn = d.turn ?? null;
      }
    };
  }

  // Reset per-turn state so the node is reusable across replies without
  // reallocating the sample buffer or re-instantiating the worklet.
  resetTurn() {
    this.isDone = false;
    // Host turn id carried by this turn's 'done' (null until one arrives).
    this.doneTurn = null;
    this.playing = false;
    // Whether any real audio has been rendered this turn. Separates a turn's
    // pre-roll (nothing to extrapolate from, and not a defect) from a
    // mid-turn underrun.
    this.hasPlayed = false;
    // Carry-over byte for split samples across chunks
    this.carry = null;
    this.writePos = 0;
    this.readPos = 0;
    // Concealment ring state and the current fade position.
    this.concealLen = 0;
    this.concealWrite = 0;
    this.concealPos = 0;
    this.concealGain = 1;
    // Episode flags, so a multi-quantum gap counts as one event.
    this.concealing = false;
    this.concealedSilence = false;
    // Reported to the host on 'stop'. A fresh object per turn: the one just
    // posted must not be mutated by the next turn.
    this.stats = {
      concealedSamples: 0,
      silentConcealedSamples: 0,
      concealmentEvents: 0,
      silentConcealmentEvents: 0,
    };
  }

  // End the current turn: notify the host and rearm for the next reply.
  // Must NOT return false from process() — a processor that stops is dead
  // for good, forcing a new node (and buffer) per reply.
  // \`reason\` ('interrupt' | 'done') tells the host which turn boundary this
  // stop belongs to — interrupt-stops are dropped host-side, flush() having
  // already settled that turn — and \`turn\` names WHICH turn drained (the id
  // this turn's 'done' carried), so a drain-stop still in flight when a
  // barge-in lands cannot settle the next turn's done() early.
  stopTurn(reason) {
    this.port.postMessage({ event: 'stop', reason, turn: this.doneTurn, stats: this.stats });
    this.resetTurn();
  }

  // Cover a quantum (from \`start\`) where real audio should have been.
  //
  // Before the turn's first samples there is nothing to extrapolate from, so
  // the gap is plain silence and counted as nothing — WebRTC likewise only
  // counts concealment once playout has begun. After that, loop the retained
  // tail under a decaying gain: a hard zero-fill is a discontinuity mid-word,
  // which is the click that makes a brief stall sound like breakage.
  coverGap(out, start) {
    if (!this.hasPlayed) {
      out.fill(0, start);
      return;
    }
    if (!this.concealing) {
      this.concealing = true;
      this.concealedSilence = false;
      this.stats.concealmentEvents++;
    }
    const total = out.length - start;
    const len = this.concealLen;
    let silent = 0;
    // Second condition: once the fade has decayed to the floor, every sample
    // the loop would emit is 0 anyway — bulk-fill instead of running 128
    // branchy iterations per quantum for the whole tail of a long stall.
    if (len === 0 || this.concealGain < ${PLAYBACK_CONCEAL_FLOOR}) {
      out.fill(0, start);
      silent = total;
    } else {
      let g = this.concealGain;
      for (let i = start; i < out.length; i++) {
        if (g < ${PLAYBACK_CONCEAL_FLOOR}) {
          // The fade has run out: keep counting the gap, but stop looping a
          // fragment that is now inaudible anyway.
          out[i] = 0;
          silent++;
          continue;
        }
        out[i] = this.concealBuf[this.concealPos] * g;
        this.concealPos = this.concealPos + 1 === len ? 0 : this.concealPos + 1;
        g *= this.concealDecay;
      }
      this.concealGain = g;
    }
    this.stats.concealedSamples += total;
    if (silent > 0) {
      this.stats.silentConcealedSamples += silent;
      if (!this.concealedSilence) {
        this.concealedSilence = true;
        this.stats.silentConcealmentEvents++;
      }
    }
  }

  // Retain the tail of a rendered quantum as the next gap's concealment
  // source, and close any episode the real audio just ended.
  rememberTail(out, n) {
    const cap = this.concealCapacity;
    const take = Math.min(n, cap);
    // Bulk copies (this runs on every cleanly rendered quantum): the tail is
    // one contiguous source run, landing in at most two ring runs.
    const tail = out.subarray(n - take, n);
    const first = Math.min(take, cap - this.concealWrite);
    this.concealBuf.set(tail.subarray(0, first), this.concealWrite);
    if (take > first) this.concealBuf.set(tail.subarray(first), 0);
    this.concealWrite = (this.concealWrite + take) % cap;
    this.concealLen = Math.min(cap, this.concealLen + take);
    // Read the loop oldest-first; once the ring is full the write cursor is
    // the oldest retained sample.
    this.concealPos = this.concealLen === cap ? this.concealWrite : 0;
    this.concealing = false;
    this.concealGain = 1;
  }

  ingestBytes(uint8) {
    let bytes = uint8;

    if (this.carry !== null) {
      const merged = new Uint8Array(1 + bytes.length);
      merged[0] = this.carry;
      merged.set(bytes, 1);
      bytes = merged;
      this.carry = null;
    }

    if (bytes.length % 2 !== 0) {
      this.carry = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }

    if (bytes.length === 0) return;
    const numSamples = bytes.length / 2;
    const cap = this.capacity;
    const samples = this.samples;
    if (this.littleEndian && (bytes.byteOffset & 1) === 0) {
      // Fast path: 2-byte-aligned LE bytes wrap directly as an Int16Array;
      // copy wrap-aware in at most two runs with no per-sample DataView call
      // or modulo. This runs on the realtime audio thread.
      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, numSamples);
      let src = 0;
      let dst = this.writePos % cap;
      while (src < numSamples) {
        const run = Math.min(numSamples - src, cap - dst);
        for (let j = 0; j < run; j++) {
          samples[dst + j] = int16[src + j] / 0x8000;
        }
        src += run;
        dst = 0;
      }
    } else {
      // Odd byte offset (or big-endian host): fall back to per-sample reads.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      let dst = this.writePos % cap;
      for (let i = 0; i < numSamples; i++) {
        samples[dst] = view.getInt16(i * 2, true) / 0x8000;
        dst++;
        if (dst === cap) dst = 0;
      }
    }
    this.writePos += numSamples;
    // If the producer outran the consumer by more than the buffer holds, drop
    // the oldest unplayed audio rather than reading samples we've overwritten.
    if (this.writePos - this.readPos > this.capacity) {
      this.readPos = this.writePos - this.capacity;
    }
  }

  process(inputs, outputs) {
    // No output wired up yet — nothing to render this quantum. Throwing here
    // would permanently kill the processor (the node is persistent per
    // session), so guard like the capture processor does.
    if (!outputs[0] || !outputs[0][0]) return true;
    const out = outputs[0][0];
    const avail = this.writePos - this.readPos;

    // Report the unplayed backlog to the host (\`playback_progress\`). This IS
    // the closed-loop signal: the host otherwise models playback open-loop —
    // every forwarded chunk assumed to start playing on arrival at exactly
    // 1.0x — and cannot see a buffer that has run ahead of the wall clock.
    // Measured against a client draining at 0.6x, the host declared the line
    // silent while it still held seconds of the reply, and then opened the
    // speaking-edge gate over speech the caller had not heard.
    //
    // Sent from process() rather than a timer because this is the only place
    // that sees the buffer on the audio thread; the counter is in QUANTA, so
    // it costs an integer compare per render and no clock read. Silence is not
    // reported: an empty buffer is what the host already assumes.
    this.sinceReportSamples += out.length;
    if (this.sinceReportSamples >= this.reportIntervalSamples) {
      this.sinceReportSamples = 0;
      if (avail > 0) {
        this.port.postMessage({ event: 'progress', bufferedMs: (avail / this.rate) * 1000 });
      }
    }

    // Filling: wait for the target. 'done' short-circuits it — what is
    // buffered is all there will be, so there is nothing left to wait for.
    if (!this.playing) {
      if (avail >= this.fillSamples || this.isDone) {
        this.playing = true;
      } else {
        this.coverGap(out, 0);
        return true;
      }
    }

    // Underrun: this quantum cannot be filled and more audio is still coming.
    // Go back to filling and cover the gap, leaving
    // readPos untouched — the fragment stays buffered and plays intact once
    // the buffer recovers, instead of being dribbled out a few samples at a
    // time for the rest of the turn.
    if (avail < out.length && !this.isDone) {
      this.playing = false;
      this.coverGap(out, 0);
      return true;
    }

    if (avail > 0) {
      const n = Math.min(avail, out.length);
      // Copy from the ring buffer, splitting across the wrap boundary.
      const start = this.readPos % this.capacity;
      const first = Math.min(n, this.capacity - start);
      out.set(this.samples.subarray(start, start + first), 0);
      if (n > first) out.set(this.samples.subarray(0, n - first), first);
      this.readPos += n;
      // Only reachable with n < out.length on the turn's final partial
      // quantum (the underrun branch above catches every other case).
      out.fill(0, n);
      this.hasPlayed = true;
      this.rememberTail(out, n);
      return true;
    }

    // Drained and done: end the turn. Not reachable mid-turn — an empty
    // buffer with audio still coming is the underrun branch above.
    out.fill(0);
    if (this.isDone) {
      this.stopTurn('done');
    }
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
`;

export default workletModuleUrl(playbackProcessorSource);
