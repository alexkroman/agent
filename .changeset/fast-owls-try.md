---
"@alexkroman1/aai": patch
---

Fix parallel workflow uploads storing a file nothing can read, on any deployment behind a proxy that compresses responses.

`UploadBlobs.size` measures a window by reading `Content-Length` off a body-less `HEAD`, and `Number(null)` is `0` — a perfectly safe non-negative integer — so a response that stated no length at all was read as an EMPTY object rather than an unmeasurable one. Measured against a deployed agent: Node's `fetch` advertises `zstd`, the platform's proxy honoured it, and a `content-encoding: zstd` reply carries no `Content-Length` (`identity`, `gzip` and `gzip, deflate, br` all answered `content-length: 8388608` where `zstd` answered nothing).

So `recordPart` recorded every window of every parts upload as a zero-length range: well formed, summing to a contiguous `size` of 0, and completely unreadable. A 660 MB recording uploaded successfully and then read back as nothing — the transcription desk's header probe reported "That is not a WAV file", and its streaming flow never reached the 64 KB it plans from, so the page showed an empty progress panel for the whole upload. The single-request path was unaffected because it counts bytes as they stream through and never asks a bucket.

Three fixes, because each layer had a chance to catch it and none did: a missing header now reads as ABSENT rather than as zero (an explicit `0` still reads as zero), both blob clients ask for the response unencoded, `recordPart` refuses a zero-length window on an upload that declares bytes, and the client no longer reports success over a record the agent never completed.
