---
"@alexkroman1/aai-runtime": minor
---

AssemblyAI STT now reopens a socket that has gone deaf: open and taking audio,
but sending no partial or final while the caller talks. Two signs trigger it.
The first is 2.5 s of voiced audio (15 dB over the line's noise floor and above
-45 dBFS) with no turn event. The second is a partial left open longer than
`maxTurnSilenceMs` + 1.5 s. The new socket is sent the last 3 s of audio first,
then the session's live `min_turn_silence` and keyterms. The old socket's final
flush is still accepted while it drains. On tau2-bench retail
(`universal-3-5-pro`), 4 of 5 sims flagged unresponsive sat in a 42–90 s window
with no STT events. A raw websocket client reproduces it, and a fresh socket
hears again. On recorded calls, reopening and replaying heard 54 of 58 caller
utterances against 5 without. Each reopen logs `AssemblyAI STT reopened`.
