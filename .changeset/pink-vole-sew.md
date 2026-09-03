---
"@alexkroman1/aai-runtime": major
"aai-server": major
---

Read an upload's record ONCE per read, not once per chunk.

`UploadReader.info` and `UploadReader.read` each resolve the record for themselves and every reader needs both, so one logical read cost two look-ups of one row and the byte route cost one per `UPLOAD_CHUNK_BYTES` of the answer. On a deployed guest a look-up is a `POST /:slug/upload-records` across the platform and into the admin pool — measured over 48h of production at n=1428, mean 537ms, and within one 33-segment transcription it outnumbered the journal 515 to 212 for a run that moved 140 part windows.

`UploadReader.open(id)` hands back the record AND a reader bound to the windows THAT record named. `readUpload` is 1 look-up where it was 2; `GET /workflows/uploads/:id` is 1 where it was N+1 for an N-chunk answer. It also PINS the window map for the operation, which the route's own `Content-Length` was already assuming: a part landing mid-download could previously answer bytes the header had promised were something else.

BREAKING: `UploadStore` gains a required `open(id)`, so a host implementing that interface must supply one. `UploadReader.open` is OPTIONAL and `readUpload` falls back to `info` + `read`, so every two-method fake — `stubUploads` included — is unchanged.

The claim path is deliberately untouched at two calls: `recordParts` reads before it writes because it validates every named window against the DECLARED total and decides the finished-upload refusal, neither of which the write can see.
