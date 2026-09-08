# packages/aai — S2S mode

A SIBLING of `CLAUDE.md`, read on demand. That guide was AT its 120,000-char
cap with `## Session modes` holding 20% of it, and almost all of that 20% was
this: wire-level findings about AssemblyAI's Voice Agent API and OpenAI
Realtime, which an agent needs once it is already working on S2S and never
before. `CLAUDE.md` keeps the three modes' SELECTION rules — which fields put an
agent in which mode — and points here.

Everything below is verbatim from that section, plus the sample-rate rule that
was stated alongside it.

- **S2S mode** (explicit opt-in — `s2s: assemblyAIS2s()` from the main
  export, or `openAIS2s()` from `@alexkroman1/aai/s2s`) uses
  `createS2sTransport()` in `packages/aai/src/host/transports/s2s-transport.ts`.
  The host opens a single WebSocket to AssemblyAI's speech-to-speech
  service; STT, the LLM loop, and TTS all run service-side and audio/events
  relay through that one socket. There is no way to reach S2S by omission —
  only the `s2s` descriptor selects it.

  **The Voice Agent API accepts ONE sample rate — 24 kHz, both directions — so
  the CLIENT must send true 24 kHz audio, not 16 kHz relabelled as 24.** The host
  pins and advertises the rate and refuses a client that declares another; it does
  NOT resample. Relabelled audio is the case to know about because it has NO
  symptom — the agent greets normally and is then permanently deaf, which
  reads as a service outage rather than an audio bug.

  **`ASSEMBLYAI_S2S_SAMPLE_RATE` (`sdk/s2s-constants.ts`) owns all of it**: the
  three-way live measurement, the tau2 scores with the pin in place, and why a
  resampler was built and reverted. `pinAssemblyS2sRates` (`host/runtime-config.ts`)
  is the pin; `assertHostRatesSupported` (`host-mode.ts`) is the counterpart it
  cannot reach, refusing a host-mode handshake that declares a rate this
  transport cannot honour.

  **S2S has no agent captions on tool-call turns, and `transcript.agent.delta`
  is the remedy.** Neither reply of a tool-call turn emits `transcript.agent`, so
  a tool-using agent renders blank reply text for exactly the turns that do the
  work — measured against the live service, and the vendor's own docs contradict
  each other on whether it is intended. The per-word deltas DO arrive (511 frames
  over one 215s session; this guide asserted the opposite for a while), and
  `s2s.ts` forwards them as a partial and commits them on a COMPLETED reply that
  sent no final — never on an interrupted one, which would put words in history
  the caller never heard. **Read `host/_s2s-reply.ts`'s module doc** for both
  measurements, the two properties that decide how the deltas are consumed, and
  the anomaly log; this guide is at its cap and that module owns the finding.

  **S2S sends Voice Focus, `sttPrompt`, and the three descriptor options
  (`voice`, `languages`, `keyterms`).** `updateSession` pins
  `input.voice_focus`/`voice_focus_threshold` from the same
  `DEFAULT_VOICE_FOCUS`/`DEFAULT_VOICE_FOCUS_THRESHOLD` constants the pipeline
  STT stage reads (the S2S default is the service's 0.7, and the interferer that
  matters is background speech), and forwards `sttPrompt` as
  `input.transcription_prompt`, trimmed to that field's documented 1750-char cap
  — keeping the HEAD, unlike `agent_context`'s tail-keeping trim, because this is
  a standing vocabulary description rather than a trailing question.

  `sttPrompt` was pipeline-only until 2026-08-06 — a SILENT config drop, since
  both `agent({ sttPrompt })` and `host.sttPrompt` reached the agent definition
  and only `pipeline-transport.ts` read it. **The fix then landed the runtime
  half and left the TYPE half closed for three days**, which is worth more than
  the bug was: `PipelineOnlyField` still listed `sttPrompt`, so `agent({ s2s,
  sttPrompt })` was a compile error naming a rule that was no longer true, and
  the only way to reach the measured win was a raw `export default {...}`. A
  dropped field has a mirror image — a REJECTED field the runtime honours — and
  it reads to an author as "unsupported", so it draws no bug report at all.
  **When a config field's mode rule changes, the type gate, the doc, and the
  transport all move together or none of them do.**
  `runtime-transport.test.ts` pins the forwarding at the point it was missing.

  `input.language_codes`, `input.keyterms` and `output.voice` are reachable as of
  2026-08-09: `assemblyAIS2s()` takes `{ voice, languages, keyterms }`, read off
  the stored descriptor by `readAssemblyS2sOptions` in `runtime-transport.ts` and
  forwarded on presence only. Before that an S2S agent could not pick its voice
  at all, so this guide's "the voice rides on the `s2s` descriptor" was wrong
  when written and is now merely how it works. **`AssemblyAIS2sOptions`
  (`sdk/providers/s2s/assemblyai.ts`) owns the rest** — the tau2-bench retail
  measurement behind the three settings (spelled first name 1/6 -> 6/6, word
  recall ~0.89 -> ~0.93), why `languages` must stay AUTHOR-controlled rather than
  defaulted, why an unverified `voice` id leaves an agent that connects, reports
  ready and never speaks, and why `turn_detection` is deliberately not pinned.

  **An in-band service error is NOT the end of the session, and a fatal frame
  is not a banner.** An `error.reported` with no `fatal` key means the session is
  over, and aai-ui answers one by calling `cleanupAudio()`, bumping the
  connection generation and setting `running: false` — the MICROPHONE IS
  RELEASED. Both S2S transports used to report every in-band error that way
  (AssemblyAI's `session.error` with a non-expiry code, its bare `error` frame,
  OpenAI Realtime's `error` event), and none of those closes the socket: the
  conversation demonstrably continued — `tool_call`, `reply_done` and audio all
  arrived afterwards on most fuzz seeds — to a client that could no longer hear
  anyone, and a later event even recovered its state to "listening"
  (`clearRecoveredError`), leaving a session that looks live and is deaf. They
  now pass `{ fatal: false }`; the *only* reporter of session death is the
  close/failed-resume path (`endSession`), which is the one place that knows the
  link is gone and attaches the close code. A truly terminal error is still
  covered, because the service closes the socket after it. Note session-core logs
  a non-fatal error at DEBUG, so `s2s.ts` logs the `error` frame's message itself
  at warn — demoting the client-facing severity must not also make the service's
  complaint invisible.

  **Retiring the session must also DROP THE LINK** (`endSession`). Most fatal
  paths arrive from a close, where the socket is already gone — but not all: when
  the service rejects a `session.resume` with `session_not_found` it says so IN
  BAND and leaves the socket OPEN, so the transport went on holding a live
  (billed) provider session and relaying its frames to a client it had just told
  the call was over. `endSession` closes the socket, drops the handle and the
  queued tool results, and the inbound callbacks are gated on the session still
  being live (`whileLive`) — `close()` does not un-deliver what is already
  buffered.

  **`stop()` must be able to abandon a handshake that has not completed**
  (`ConnectS2sOptions.signal`, aborted by the transport's `teardown` controller).
  `handle?.close()` can only reach a socket that OPENED: `connectS2s` returns a
  handle only on `open`, and `ws` sets no `handshakeTimeout`, so a client that
  hung up mid-resume left a half-open (billed) provider connection pinned for the
  life of the process, with nothing anywhere holding a reference to close. A
  connect that loses this race is swallowed rather than reported: we aborted it,
  and there is no session left to fail. All three of these came out of the S2S
  property test, which shrank the last one to two commands: `session.ready`, then
  a transient drop.
