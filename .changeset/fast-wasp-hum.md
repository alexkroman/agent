---
"@alexkroman1/aai": patch
---

Overlap the upload byte pipeline with itself: a whole-file write now puts several windows while the next one is still arriving, and the byte route reads chunks ahead of the socket instead of paying a round trip per megabyte. A window is still buffered whole before its write starts, so a failed write is still re-sendable. Also stops the read route leaking a `close` listener per chunk it paces.
