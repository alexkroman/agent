---
"@alexkroman1/aai": patch
---

Resume a paused upload instead of restarting it: a caller-named upload (`uploadStream`, which every workflow form uses) is now cut into parts even when the file fits in one, so pausing a recording under 8 MiB and resuming it sends the missing windows rather than the whole file — which the store then refused as a taken id.
