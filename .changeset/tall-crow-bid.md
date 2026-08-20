---
"@alexkroman1/aai": patch
---

Pipeline TTS: remove the 32-character cap that ended a coalesced provider send. Terminal punctuation is now the only thing that ends a batch, so a long sentence is no longer cut mid-clause into a fragment the provider reads with a falling final intonation — which was heard as an obvious pause a few words in.
