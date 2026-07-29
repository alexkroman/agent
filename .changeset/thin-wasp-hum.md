---
"@alexkroman1/aai": patch
---

Fix voice-agent reliability, security, and correctness across the aai core:

- OpenAI Realtime: server-VAD barge-in now flushes client playback (was talking over the user).
- S2S transport: an unexpected idle close now surfaces an error instead of zombie-ing the session; post-cancel audio is dropped until the next reply.
- KV: expireIn is now enforced on all backends (memory/fs/s3), not just Redis; size cap counts bytes not UTF-16 code units.
- fsKv: key-traversal guard now rejects ../ escapes (and reads/deletes), plus a key-length bound.
- Providers: Soniox/Rime sockets keep a crash-safe error guard through teardown; Rime/AssemblyAI TTS surface abnormal server closes; Cartesia drops in-flight audio past cancel; Soniox flushes a trailing final on quiet.
- ws-handler: session-start failure and a createSession throw now send the client an error frame and close instead of hanging or crashing the host.
- Pipeline: start() no longer proceeds after a provider-open failure; S2S file-upload replay is paced so audio isn't dropped past the socket buffer.
- fetch_json caps response body size; lenientParse flags invalid known-type messages; ws-upgrade handles empty sessionId and '?' in query values; stream-repair drops stale content-length/encoding headers.
- Dependencies: bump undici 7→8 (the SSRF-path dispatcher) and nanoevents 9→10, both majors; sweep the ai/@ai-sdk packages to their latest in-range patches; declare fast-check as an aai devDependency (was a phantom dep).
