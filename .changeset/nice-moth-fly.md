---
"@alexkroman1/aai": minor
---

Refuse to transcribe or copy an upload that is still arriving. `UploadInfo.size` is the contiguous READABLE PREFIX, not the final length, so five call sites could silently work on part of a recording and report success — `stepTranscribeUpload` uploaded the prefix with a chunked body so no `content-length` existed for the provider to reject, `readUploadToFile` defaulted its byte count to that prefix (the very number a polling caller reads to learn the store came back short), and a template derived its whole segment plan's width from it, fanning out over half a recording. All now go through `requireCompleteUpload`, published on `@alexkroman1/aai/step` with `UploadIncompleteError`, whose `retryable = false` makes it fatal rather than burning a file-sized step's retry budget.
