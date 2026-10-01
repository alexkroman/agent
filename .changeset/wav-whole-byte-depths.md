---
"@alexkroman1/aai": patch
---

`parseWav` now refuses a WAV whose bit depth is not a whole number of bytes (a
4-, 12- or 1-bit header) with `UnsupportedRecordingError`, instead of answering
a fractional frame size that put every computed cut mid-sample. Found by new
fast-check properties over arbitrary input to `parseWav`, `readEventStream`, the
platform socket frames and session tickets.
