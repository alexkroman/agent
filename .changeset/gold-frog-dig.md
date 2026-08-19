---
"@alexkroman1/aai": patch
---

Double the default parallel-upload width to 8, because a part's cost is half fixed.

On a deployed agent every part is two requests: the window goes to the platform, and a body-less `PUT …/parts?offset=…&stored=1` tells the agent it landed. Measured per 4 MiB part against a deployed agent — byte PUT 926-2121ms, the body-less claim 1604-1969ms. Roughly half a part's wall time is a round trip carrying nothing, and it is per-PART rather than per-byte, so the only thing that hides it is overlap. Extrapolated over a 660 MB recording, ~77s at four wide against ~38s at eight.

The part size stays 8 MiB. A first attempt halved it to 4 on the grounds that a smaller window makes a reset cheaper — true, but the trade only pays if a part's cost is mostly its bytes, and it is not; halving it doubles how many times the fixed toll is paid. 16 MiB measures ~28% quicker per byte with a far tighter spread and is deliberately not taken: at eight wide it would ask a shared memory-bounded process to buffer 128 MiB for one upload, it sits on the reset shoulder, and it raises the size below which a file gets no parallel upload and no retry at all from 16 MB to 32 MB.

`UPLOAD_PART_CONCURRENCY`'s doc also DELETES the table that used to justify 4. It reported a cliff at width 16 that did not exist: the sweep reused one connection with a 1s gap and the platform penalises a connection after it trips, so every cell inherited the previous cell's penalty and the widest cells, run last, looked catastrophic. Re-measured with a fresh connection per run, 16 wide completes 16 of 16.
