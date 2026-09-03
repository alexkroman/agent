// Copyright 2026 the AAI authors. MIT license.
/**
 * What AssemblyAI's Voice Agent API requires of the AUDIO, and what it costs to get
 * it wrong.
 *
 * Split from `constants.ts` for the same file-length reason `client-audio-constants.ts`
 * and `upload-constants.ts` are, and re-exported from it, so the import path every
 * other module uses is unchanged. It is one constant and a page of measurement,
 * which is the shape that splits well: the number is trivial and the reason it is
 * that number is not.
 */

/**
 * The ONLY sample rate AssemblyAI's Voice Agent API accepts, in both
 * directions. Measured against the live service with a standalone WebSocket
 * client: declaring 8000 or 16000 for either `input.format` or `output.format`
 * is answered ~10s later with `session.error{code:"internal_error"}` and close
 * 1011; 24000 is accepted.
 *
 * Sending audio at another rate is worse than declaring one, because it has NO
 * symptom: the service applies 24 kHz regardless, so 16 kHz capture is decoded
 * 1.5x fast and produces no `input.speech.started`, no `transcript.user` and no
 * error at all. The agent greets normally and is then permanently deaf, which
 * reads as a model or service outage rather than an audio bug.
 *
 * Hence two users of this constant, not one: `pinAssemblyS2sRates` makes the
 * host say 24 kHz everywhere (ready frame included, so a client that captures
 * off that frame is right by construction), and `assertHostRatesSupported`
 * REFUSES a host-mode client that declares it will send something else — the
 * case the pin cannot reach, because it can change every number and no byte.
 *
 * ## The three-way measurement
 *
 * Live service, 2026-08-05, standalone WebSocket client, the same real utterance
 * fed three ways:
 *
 * | sent | declared | result |
 * | --- | --- | --- |
 * | 16 kHz bytes | 24 kHz | `session.ready`, then **nothing at all** |
 * | true 24 kHz | 24 kHz | speech edges, correct transcript, 279 KB of reply audio |
 * | 16 kHz bytes | 16 kHz | `session.error{internal_error}` + close **1011** |
 *
 * Row one is the whole problem, and it is why the pin is necessary and not
 * sufficient: relabelled audio produces no error, so the agent greets normally and
 * is then permanently deaf. The tau2 run measured WITH the pin in place scored
 * **2/25 against 15/25 and 18/25 for the two pipeline transports running the same
 * tasks at the same minute**, which is what makes that a transport finding rather
 * than a bad afternoon.
 *
 * ## The host does NOT resample, and that is a decision
 *
 * A resampler was built and reverted. It worked — 16 kHz converted to true 24 kHz
 * transcribed correctly 5/5 live, against 4/5 returning nothing when relabelled —
 * but upsampling can only preserve or degrade, since it invents no bandwidth, and
 * it put ~150 lines of stateful DSP in the hot audio path to paper over a client
 * that could simply send the right rate. Every client already owns its own rate
 * conversion: the browser's WebAudio does it, and tau2 resamples from 8 kHz μ-law
 * regardless, so making that 8→24 costs nothing. Rate conversion belongs at the
 * EDGE; the host's job is to state the requirement and refuse a client that will
 * not meet it.
 *
 * @internal
 */
export const ASSEMBLYAI_S2S_SAMPLE_RATE = 24_000;
