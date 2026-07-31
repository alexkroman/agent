---
"aai-studio-server": patch
---

Run the studio coding agent's CPU-bearing tool work off the main thread:
`grep`'s regex scan and `edit_file`'s fuzzy matching + Myers diff now
execute on a dedicated scan worker thread with a hard
`worker.terminate()` deadline (2s). Previously both ran model-controlled
input through superlinear algorithms on the server's event loop, where a
catastrophic regex (`(a+)+$`) could pin every session on the process
indefinitely and a large mostly-different edit stalled it for ~7s — and
the per-tool pTimeout cannot stop either, since a promise race needs the
event loop the computation is pinning. Worker failures cross the thread
boundary as classified wire data and rehydrate to the same
`StudioGrepError`/`StudioEditError` the sync implementations throw; the
presentation diff additionally self-elides at 500ms (jsdiff `timeout`) so
an oversized-but-legit edit still applies. Invalid globs now surface as
actionable `StudioGrepError`s instead of unclassified throws.
