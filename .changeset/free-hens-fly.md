---
"@alexkroman1/aai": patch
"aai-server": patch
---

Fix hot-path concurrency bugs: TTS reconnect deadline + clean-close mute + stale FlushDone pairing, session resume takeover/overlap races, host-mode handshake frame loss + per-connection runtime leak, post-stop transport events, client-cancel tool abort, drain-window barge-in classification, false-interruption resume vs committed final, S2S error-before-close and tool.result redelivery after resume, tool timeout firing ctx.signal, per-agent tool-fetch concurrency parity, sandbox teardown closing live session sockets, orchestrator re-resolve identity re-check, NDJSON/pool/cold-spawn hardening
