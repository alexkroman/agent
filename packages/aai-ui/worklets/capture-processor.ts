// Capture worklet: captures mic Float32 samples, resamples to STT rate if
// needed, converts to Int16 PCM, and sends chunks to the main thread.

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
    this.port.onmessage = (e) => {
      if (e.data.event === 'start') this.recording = true;
      else if (e.data.event === 'stop') this.recording = false;
    };
  }

  resample(input) {
    const ratio = this.ratio;
    const n = input.length;
    if (n === 0) return new Float32Array(0);
    // Extended frame: index 0 = prev (previous block's last sample),
    // index k>=1 = input[k-1]. Interpolate at fractional positions stepping by
    // ratio, carrying \`pos\` across calls to preserve the sample clock.
    const out = [];
    let pos = this.pos;
    while (pos < n) {
      const idx = pos | 0;
      const frac = pos - idx;
      const a = idx === 0 ? this.prev : input[idx - 1];
      const b = input[idx];
      out.push(a + frac * (b - a));
      pos += ratio;
    }
    // Shift the origin to this block's last sample for the next call.
    this.prev = input[n - 1];
    this.pos = pos - n;
    return Float32Array.from(out);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || !this.recording) return true;

    const raw = input[0];
    const samples = this.needsResample ? this.resample(raw) : raw;

    // Convert Float32 -> Int16
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    this.port.postMessage({ event: 'chunk', buffer }, [buffer]);
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
`;

const script = new Blob([CaptureProcessorWorklet], {
  type: "application/javascript",
});
const src = URL.createObjectURL(script);
export default src;
