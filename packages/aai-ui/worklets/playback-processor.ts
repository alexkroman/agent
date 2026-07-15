// Playback worklet: receives raw PCM16 LE bytes, handles byte alignment,
// converts to float32, and plays with a small jitter buffer.

const PlaybackProcessorWorklet = `
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const rate = options.processorOptions?.sampleRate ?? 24000;
    // Wait for ~400ms of audio before starting.
    // If 'done' arrives first (short utterance), start immediately.
    this.jitterSamples = Math.floor(rate * 0.4);
    // Float32 ring buffer — 60s at the context sample rate. Allocated once for
    // the node's lifetime; per-turn state resets via resetTurn(). writePos and
    // readPos are absolute (monotonic) sample counts; the buffer is indexed
    // modulo capacity so a reply longer than 60s keeps playing instead of
    // writing past the end and going silent.
    this.capacity = rate * 60;
    this.samples = new Float32Array(this.capacity);
    // Report playback position every ~50ms for word-level text sync
    this.progressInterval = Math.floor(rate * 0.05);
    this.resetTurn();

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

  // Reset per-turn state so the node is reusable across replies without
  // reallocating the sample buffer or re-instantiating the worklet.
  resetTurn() {
    this.interrupted = false;
    this.isDone = false;
    this.playing = false;
    // Carry-over byte for split samples across chunks
    this.carry = null;
    this.writePos = 0;
    this.readPos = 0;
    this.samplesSinceProgress = 0;
  }

  // End the current turn: notify the host and rearm for the next reply.
  // Must NOT return false from process() — a processor that stops is dead
  // for good, forcing a new node (and buffer) per reply.
  stopTurn() {
    this.port.postMessage({ event: 'stop' });
    this.resetTurn();
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
      this.samples[this.writePos % this.capacity] = view.getInt16(i * 2, true) / 0x8000;
      this.writePos++;
    }
    // If the producer outran the consumer by more than the buffer holds, drop
    // the oldest unplayed audio rather than reading samples we've overwritten.
    if (this.writePos - this.readPos > this.capacity) {
      this.readPos = this.writePos - this.capacity;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (this.interrupted) {
      out.fill(0);
      this.stopTurn();
      return true;
    }

    const avail = this.writePos - this.readPos;

    // Wait for jitter buffer to fill, unless done (short utterance)
    if (!this.playing) {
      if (avail >= this.jitterSamples || this.isDone) {
        this.playing = true;
      } else {
        out.fill(0);
        return true;
      }
    }

    if (avail > 0) {
      const n = Math.min(avail, out.length);
      // Copy from the ring buffer, splitting across the wrap boundary.
      const start = this.readPos % this.capacity;
      const first = Math.min(n, this.capacity - start);
      out.set(this.samples.subarray(start, start + first), 0);
      if (n > first) out.set(this.samples.subarray(0, n - first), first);
      this.readPos += n;
      this.samplesSinceProgress += n;
      if (this.samplesSinceProgress >= this.progressInterval) {
        this.port.postMessage({ event: 'progress', readPos: this.readPos });
        this.samplesSinceProgress = 0;
      }
      out.fill(0, n);
      return true;
    }

    // No data: output silence, end the turn only when done
    out.fill(0);
    if (this.isDone) {
      this.stopTurn();
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
