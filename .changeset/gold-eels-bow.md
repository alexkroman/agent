---
"@alexkroman1/aai": minor
---

Read an upload into a local file with a bounded fan-out instead of one window at a time, and let a multipart part carry its bytes as chunks so a request body is not copied twice.

`readUploadToFile` was a serial walk, argued as "the bytes land in one file at one offset each, so concurrency buys nothing" — true of the local write, and silent about the remote read, which is what the call actually costs: on a deployed guest every window is a brokered 302 plus a Range GET, so window N+1 could not start until window N had fully landed. The write half of the same round trip has always fanned out. It now reads `STEP_FILE_READ_CONCURRENCY` (4, matching that write width and its 32 MiB) windows at once and writes them positionally, but only where the upload is known whole; a caller passing `size` is judging completeness itself and still gets the ordered walk, because a short answer there has to stop the copy rather than leave a hole four windows back. The concurrent path answers with the contiguous prefix and truncates to it.

`MultipartPart.bytes` and `stepTranscribeSync`/`stepTranscribeSyncClassified` now also accept a list of chunks, and `wavHeader` writes a WAV header on its own. A step that framed a segment and then built a request around it held the audio twice; passing the header and the samples as two chunks holds it once. Same bytes on the wire, and the body is still one buffer, so `Content-Length` and transport retry are unchanged. `sliceOf` also stopped copying a raw `ArrayBuffer` window it could view.
