---
"@alexkroman1/aai": minor
---

Make workflow uploads faster and recoverable. Store side: the whole-file writers batch their chunk writes too (the streamed one was publishing `size` after every megabyte, doubling that loop's round trips), a batch is now bounded by time as well as by count so a slow uplink still advances `size`, the upload pool is sized to the client's part fan-out instead of holding it at 2, and the chunk column drops Postgres' LZ attempt on every megabyte of audio. Client side: part retries back off with jitter and honour `Retry-After` instead of re-sending at once, the claim and the closing record read are retried too, the first failure aborts the parts still in flight, and a file is cut into parts by default — the single-request path cannot retry at all.
