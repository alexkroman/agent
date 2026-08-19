// Capture worklet: captures mic Float32 samples, converts them to Int16 PCM,
// batches ~bufferSeconds of audio in a preallocated buffer, and posts one
// transferred ArrayBuffer per flush — instead of one tiny postMessage per
// 128-sample render quantum.
//
// Rate conversion is deliberately NOT done here. The capture AudioContext is
// created at the STT rate (audio.ts asserts the browser honored it), so the
// browser's band-limited resampler has already done the work by the time
// samples arrive. Doing it here instead meant linear interpolation, which
// folds everything above the new Nyquist back into the band as aliasing.
//
// It also probes once for a dead microphone (see MIC_SILENCE_PROBE_MS).

import { MIC_BUFFER_SECONDS, MIC_SILENCE_PROBE_MS } from "../types.ts";
import { workletModuleUrl } from "./_module-url.ts";

/** Raw worklet source — exported so tests can evaluate the processor directly. */
export const captureProcessorSource = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.recording = false;
    const opts = options.processorOptions || {};
    // The context runs at the STT rate, so this is both the input and the
    // output rate — there is nothing to convert.
    this.rate = opts.sampleRate || sampleRate;
    // Int16 accumulation buffer: flushed to the main thread as one transferred
    // ArrayBuffer once ~bufferSeconds of samples are batched. Sized 2x the
    // flush target so a whole render quantum always fits before flushing.
    this.targetSamples = Math.max(1, Math.round(this.rate * (opts.bufferSeconds || ${MIC_BUFFER_SECONDS})));
    this.pending = new Int16Array(this.targetSamples * 2);
    this.pendingLen = 0;
    // Dead-mic probe: samples left to inspect before concluding the device
    // delivers nothing but digital silence. Only consumed while recording, so
    // the cost disappears after the window (or after the first real sample).
    this.probeSamplesLeft = Math.round(
      (this.rate * (opts.silenceProbeMs ?? ${MIC_SILENCE_PROBE_MS})) / 1000,
    );
    this.port.onmessage = (e) => {
      if (e.data.event === 'start') this.recording = true;
      else if (e.data.event === 'stop') {
        // Final flush so the tail of speech isn't dropped on close, then ack
        // so the host knows the tail chunk (if any) has been posted and it is
        // safe to tear the context down.
        this.flush();
        this.recording = false;
        this.port.postMessage({ event: 'stopped' });
      }
    };
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

  // Watch the first window of input for any nonzero sample. One is enough to
  // prove the device is live — a real mic in a quiet room still carries a
  // noise floor, so all-zeros means muted, wrong input, or no input at all.
  probeForSilence(channel) {
    for (let i = 0; i < channel.length; i++) {
      if (channel[i] !== 0) {
        this.probeSamplesLeft = 0;
        return;
      }
    }
    this.probeSamplesLeft -= channel.length;
    if (this.probeSamplesLeft <= 0) {
      this.port.postMessage({ event: 'silent' });
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || !this.recording) return true;

    if (this.probeSamplesLeft > 0) this.probeForSilence(input[0]);

    this.accumulate(input[0]);
    if (this.pendingLen >= this.targetSamples) this.flush();
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
`;

export default workletModuleUrl(captureProcessorSource);
