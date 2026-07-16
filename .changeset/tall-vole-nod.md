---
"@alexkroman1/aai": minor
---

Pipeline endpointing now uses the STT provider's end-of-turn confidence (e.g. AssemblyAI's end_of_turn_confidence) to size the settle window: high-confidence finals take the short complete-settle window regardless of punctuation, low-confidence finals wait the full window. Finals without a provider score keep the existing lexical heuristic. SttEvents.final gains an optional endOfTurnConfidence parameter.
