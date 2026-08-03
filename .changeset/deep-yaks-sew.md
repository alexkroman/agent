---
"@alexkroman1/aai": minor
---

Voice-agent defaults hardened against three failure modes measured across tau2-bench, EVA, and Full-Duplex-Bench v3: the agent may no longer describe an action as done without a successful tool result (EVA scored faithfulness 0.075 on claims like "your window seat is reserved" with no assign_seat call); spoken identifiers must be written in normal written form in tool arguments ("K dash 2" is K2, "Z K 3 F F W" is ZK3FFW); long tool results must be summarized rather than enumerated (30% of synthesized audio was discarded by barge-in). DEFAULT_MIN_TURN_SILENCE_MS raised 1500 -> 2000, which fixes a confirmed mid-utterance split on hesitant speech.
