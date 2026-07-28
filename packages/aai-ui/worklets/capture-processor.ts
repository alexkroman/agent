// Capture worklet: captures mic Float32 samples, resamples to STT rate if
// needed, converts to Int16 PCM, batches ~bufferSeconds of audio in a
// preallocated buffer, and posts one transferred ArrayBuffer per flush —
// instead of one tiny postMessage per 128-sample render quantum.

const CaptureProcessorWorklet = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.recording = false;
    const opts = options.processorOptions || {};
    this.fromRate = opts.contextRate || sampleRate;
    this.toRate = opts.sttSampleRate || sampleRate;
    this.ratio = this.fromRate / this.toRate;
    this.needsResample = this.fromRate !== this.toRate;
    // Streaming-resampler state carried across process() blocks so the output
    // clock doesn't drift and there's no discontinuity at 128-sample block
    // boundaries. \`prev\` is the previous block's last input sample (used to
    // interpolate across the boundary); \`pos\` is the fractional read position,
    // in input samples, relative to an extended [prev, ...input] frame. Start
    // at 1 so the first output is input[0] (not the bogus initial prev).
    this.prev = 0;
    this.pos = 1;
    // Output buffer reused across process() calls -- the render quantum is a
    // fixed size, so allocating per call would churn the realtime audio thread.
    this.resampleBuf = null;
    // Int16 accumulation buffer: flushed to the main thread as one transferred
    // ArrayBuffer once ~bufferSeconds of output samples are batched. Sized 2x
    // the flush target so a whole render quantum always fits before flushing.
    this.targetSamples = Math.max(1, Math.round(this.toRate * (opts.bufferSeconds || 0.1)));
    this.pending = new Int16Array(this.targetSamples * 2);
    this.pendingLen = 0;
    this.port.onmessage = (e) => {
      if (e.data.event === 'start') this.recording = true;
      else if (e.data.event === 'stop') {
        // Final flush so the tail of speech isn't dropped on close.
        this.flush();
        this.recording = false;
      }
    };
  }

  resample(input) {
    const ratio = this.ratio;
    const n = input.length;
    if (n === 0) return new Float32Array(0);
    // At most ceil(n / ratio) + 1 outputs per block (pos starts in [0, ratio)).
    const maxLen = Math.ceil(n / ratio) + 1;
    if (this.resampleBuf === null || this.resampleBuf.length < maxLen) {
      this.resampleBuf = new Float32Array(maxLen);
    }
    const out = this.resampleBuf;
    // Extended frame: index 0 = prev (previous block's last sample),
    // index k>=1 = input[k-1]. Interpolate at fractional positions stepping by
    // ratio, carrying \`pos\` across calls to preserve the sample clock.
    let count = 0;
    let pos = this.pos;
    while (pos < n) {
      const idx = pos | 0;
      const frac = pos - idx;
      const a = idx === 0 ? this.prev : input[idx - 1];
      const b = input[idx];
      out[count++] = a + frac * (b - a);
      pos += ratio;
    }
    // Shift the origin to this block's last sample for the next call.
    this.prev = input[n - 1];
    this.pos = pos - n;
    return out.subarray(0, count);
  }

  // Convert Float32 -> Int16 and append to the pending batch. Writes through
  // an Int16Array directly (assignment truncates like DataView.setInt16).
  accumulate(samples) {
    let buf = this.pending;
    if (this.pendingLen + samples.length > buf.length) {
      // Defensive: only reachable if a render quantum outproduces the 1x
      // headroom above the flush target (never with 128-sample quanta).
      const grown = new Int16Array((this.pendingLen + samples.length) * 2);
      grown.set(buf.subarray(0, this.pendingLen));
      this.pending = grown;
      buf = grown;
    }
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      buf[this.pendingLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }

  // Post the batched samples as one transferred ArrayBuffer and reset.
  flush() {
    if (this.pendingLen === 0) return;
    const buffer = this.pending.buffer.slice(0, this.pendingLen * 2);
    this.pendingLen = 0;
    this.port.postMessage({ event: 'chunk', buffer }, [buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || !this.recording) return true;

    const samples = this.needsResample ? this.resample(input[0]) : input[0];
    this.accumulate(samples);
    if (this.pendingLen >= this.targetSamples) this.flush();
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
`;

/** Raw worklet source — exported so tests can evaluate the processor directly. */
export const captureProcessorSource = CaptureProcessorWorklet;

const script = new Blob([CaptureProcessorWorklet], {
  type: "application/javascript",
});
const src = URL.createObjectURL(script);
export default src;
