---
"@alexkroman1/aai-runtime": patch
---

Keep millisecond precision in a durable workflow's wake delay: a sub-second `ctx.sleep` was ceiled to a whole second by the platform dispatcher, adding ~1,000 ms to every wake (a measured 100 ms sleep resumed at ~1,780 ms). The delay is now ceiled at MILLISECOND granularity, which still guarantees a delivery is never earlier than the deadline.
