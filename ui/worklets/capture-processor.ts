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
    this.port.onmessage = (e) => {
      if (e.data.event === 'start') this.recording = true;
      else if (e.data.event === 'stop') this.recording = false;
    };
  }

  resample(input) {
    const ratio = this.ratio;
    const outLen = Math.ceil(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const idx = srcIdx | 0;
      const frac = srcIdx - idx;
      const a = input[idx];
      const b = idx + 1 < input.length ? input[idx + 1] : a;
      out[i] = a + frac * (b - a);
    }
    return out;
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
