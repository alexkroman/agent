---
"@alexkroman1/aai-runtime": minor
"@alexkroman1/aai-cli": minor
---

Run a session over your own audio I/O with `runtime.connect(sink)`, and talk to an agent from the terminal with `aai console`.

`Runtime.connect(sink, options)` takes a `ClientSink` for the session's output (events, and agent audio as PCM16 at `readyConfig.ttsSampleRate`) and returns a `SessionConnection` for its input (`sendAudio`, `sendCommand`, `close`, `ended`). A connection gets the same lifecycle a browser WebSocket gets — the start deadline, input buffered while the session starts, real-time pacing of agent audio with its barge-in ordering rules, resume by id, and end-of-session cleanup — because the WebSocket handler is now an adapter over the same transport-neutral core.

`aai console` loads the project's agent the way `aai dev` does and runs one session over the microphone and speakers (via SoX's `rec`/`play`), printing the conversation in the terminal. No server and no browser. Use headphones: there is no echo cancellation.
