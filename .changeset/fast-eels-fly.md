---
"@alexkroman1/aai-runtime": patch
---

A streamed upload whose body dies now keeps the window it was filling. The growing window cut buffered up to 8 MiB against its next target and discarded it when the body failed, so a torn stream published less than had actually arrived.
