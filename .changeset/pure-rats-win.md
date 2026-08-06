---
"@alexkroman1/aai": minor
---

Thread AssemblyAI's end_of_turn_confidence through the STT provider API: SttEvents partial/final now carry an optional SttTurnMeta whose endOfTurnConfidence is the service's 0..1 confidence that the user's turn has ended. Nothing acts on it yet; it is plumbed so a confidence-aware endpointing policy can be measured against the current time-based one. Also fixes the escape-hatch ratchet, whose 'as any' and 'as unknown as' patterns used a GNU-only word boundary that git's matcher ignores — both had been counting zero while the tree held 8 and 110.
