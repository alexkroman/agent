# API Response Fixtures

Real AssemblyAI S2S WebSocket messages recorded from the live API.
User audio was generated with Kokoro TTS (24kHz → resampled to 16kHz PCM16).

## Files

**Session lifecycle:**
- `session-ready.json` — `session.ready` messages (with config echo-back)
- `session-updated.json` — `session.updated` acknowledgements

**Greeting (no user audio):**
- `greeting-session-sequence.json` — Complete greeting session
- `reply-lifecycle.json` — Reply: started → deltas → transcript → done
- `reply-audio-samples.json` — `reply.audio` chunks (base64 truncated)

**Simple question (Kokoro audio: "Tell me a fun fact about space"):**
- `simple-question-sequence.json` — Greeting → STT → agent response
- `user-speech-recognition.json` — `speech.started`, `speech.stopped`, `transcript.user`

**Tool call (Kokoro audio: "What is the weather like in San Francisco?"):**
- `tool-call-sequence.json` — Full flow: greeting → STT → `tool.call` → response
- `tool-calls.json` — Just the `tool.call` messages with parsed args

## Notes

- Audio data is truncated (`_truncated: true`, `_originalBase64Length`).
- Real messages include extra fields (`timestamp`, `config`, `start_ms`,
  `end_ms`) that the parser must tolerate.
- Session IDs and timestamps are from the recording — tests should not
  depend on specific values.
