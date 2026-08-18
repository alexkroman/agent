---
"@alexkroman1/aai": minor
---

Start a workflow run before its file has finished uploading. `PUT /workflows/uploads/:id` stores a file under an id the CALLER chose, so the id is valid before the bytes are sent: the upload record exists from its first byte with `complete: false` and a `size` that grows, `uploadInfo` reports both, and `readUpload` already clamped its window to what has arrived. `useWorkflowStream` is the browser half (start, then one streaming PUT, then wake). `stepFetch` takes an async-iterable body so a step can forward a file it must not hold in memory, and `stubUploads` can stage an upload that is still arriving. Measured on a 10-minute 115 MB recording at 2 MB/s: six of seven segments were transcribed before the upload finished.
