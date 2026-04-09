# API Response Fixtures

Real AssemblyAI S2S WebSocket messages recorded from the live API.
User audio was generated with Kokoro TTS (24kHz resampled to 16kHz
PCM16).

## Files

**Session lifecycle:**

- `session-ready.json` — `session.ready` messages (config echo-back)
- `session-updated.json` — `session.updated` acknowledgements

**Greeting (no user audio):**

- `greeting-session-sequence.json` — Complete greeting session
- `reply-lifecycle.json` — Reply: started, deltas, transcript, done
- `reply-audio-samples.json` — `reply.audio` chunks (base64 truncated)

**Simple question (Kokoro: "Tell me a fun fact about space"):**

- `simple-question-sequence.json` — Greeting, STT, agent response
- `user-speech-recognition.json` — Speech start/stop, transcript.user

**Tool call (Kokoro: "What is the weather in San Francisco?"):**

- `tool-call-sequence.json` — Greeting, STT, tool.call, response
- `tool-calls.json` — Just the tool.call messages with parsed args

**Builtin tool call (Kokoro: "Search for Mars rover findings"):**

- `web-search-sequence.json` — Greeting, STT, web_search, response

## Notes

- Audio data is truncated (`_truncated`, `_originalBase64Length`).
- Real messages include extra fields (`timestamp`, `config`,
  `start_ms`, `end_ms`) that the parser must tolerate.
- Session IDs and timestamps are from the recording — tests should
  not depend on specific values.
