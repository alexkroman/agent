---
"aai-server": patch
"aai-guest": patch
---

Simplify sandbox management around guest-owned lifecycle: delete per-slug
horizontal scaling and the cross-replica sandbox registry (one sandbox per
slug per replica), delete host-side idle eviction (agent guests self-exit
after 5 idle minutes), make retirement fire-and-forget (one
deadline-carrying `POST /manage/drain`; the guest enforces the deadline),
replace the control-channel `bundle/load`/`tool/execute` RPCs with a
one-shot describe-mode harness exec for deploy-time config extraction, and
fail loudly on an unresolvable pinned harness image
(`SANDBOX_IGNORE_IMAGE_PINS=1` is the operator kill switch).
