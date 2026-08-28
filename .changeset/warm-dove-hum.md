---
"@alexkroman1/aai-runtime": patch
---

Fix telephony: the bridge configured itself on a `config` frame the runtime never emits (it sends `session.configured`), so both resamplers stayed null and a phone call connected with neither end able to hear the other.
