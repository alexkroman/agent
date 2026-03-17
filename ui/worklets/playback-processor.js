// Playback worklet: receives raw PCM16 LE bytes, handles byte alignment,
// converts to float32, and plays with a small jitter buffer.

const PlaybackProcessorWorklet = `
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.interrupted = false;
    this.isDone = false;
    this.playing = false;
    const rate = options.processorOptions?.sampleRate ?? 24000;
    // Wait for ~400ms of audio before starting.
    // If 'done' arrives first (short utterance), start immediately.
    this.jitterSamples = Math.floor(rate * 0.4);
    // Carry-over byte for split samples across chunks
    this.carry = null;
    // Float32 sample buffer — 60s at the context sample rate
    this.samples = new Float32Array(rate * 60);
    this.writePos = 0;
    this.readPos = 0;
    // Report playback position every ~50ms for word-level text sync
    this.progressInterval = Math.floor(rate * 0.05);
    this.samplesSinceProgress = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.event === 'write') {
        this.ingestBytes(d.buffer);
      } else if (d.event === 'interrupt') {
        this.interrupted = true;
      } else if (d.event === 'done') {
        this.isDone = true;
      }
    };
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
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const numSamples = bytes.length / 2;
    for (let i = 0; i < numSamples; i++) {
      this.samples[this.writePos++] = view.getInt16(i * 2, true) / 0x8000;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (this.interrupted) {
      this.port.postMessage({ event: 'stop' });
      return false;
    }

    const avail = this.writePos - this.readPos;

    // Wait for jitter buffer to fill, unless done (short utterance)
    if (!this.playing) {
      if (avail >= this.jitterSamples || this.isDone) {
        this.playing = true;
      } else {
        for (let i = 0; i < out.length; i++) out[i] = 0;
        return true;
      }
    }

    if (avail > 0) {
      const n = Math.min(avail, out.length);
      out.set(this.samples.subarray(this.readPos, this.readPos + n));
      this.readPos += n;
      this.samplesSinceProgress += n;
      if (this.samplesSinceProgress >= this.progressInterval) {
        this.port.postMessage({ event: 'progress', readPos: this.readPos });
        this.samplesSinceProgress = 0;
      }
      for (let i = n; i < out.length; i++) out[i] = 0;
      return true;
    }

    // No data: output silence, stop only when done
    for (let i = 0; i < out.length; i++) out[i] = 0;
    if (this.isDone) {
      this.port.postMessage({ event: 'stop' });
      return false;
    }
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
`;

const script = new Blob([PlaybackProcessorWorklet], {
  type: "application/javascript",
});
const src = URL.createObjectURL(script);
export default src;
