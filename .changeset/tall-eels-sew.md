---
"aai-server": patch
---

Extract the two identical hand-rolled sweep schedulers into one `createIntervalSweep`, and correct the wake sweep's half-wired report from `error` to `warn`. The scheduler's overrun policy is DROP (not `createCoalescingRunner`'s coalesce, and not queueing), it always `unref`s, and moving the in-flight flag out of `start()` fixes a latent overlap on start/stop/start. The severity correction is because the half-wired state is unreachable in production — both bindings arrive together in one `...base` spread — while narrow spec compositions reach it legitimately, so `error` mislabelled twelve unrelated specs.
