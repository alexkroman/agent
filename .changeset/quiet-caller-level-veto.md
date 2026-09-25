---
"@alexkroman1/aai-runtime": patch
---

Pipeline mode no longer lets background audio in the caller's channel — a television, a quiet aside across the room — barge in on a reply. Each transcript now carries the loudest level of the audio under its words (`SttTurnMeta.inputPeakDbfs`, reported by the AssemblyAI adapter on the service's own audio clock), and an utterance more than 12 dB below the caller's running speech level (the median of their recent committed turns, established after two) may not interrupt; a quiet final that lands while the agent is speaking its reply is dropped rather than committed as a turn (one begun into the agent's silent thinking time still commits). The rule only ever blocks a barge-in, fails open when no level or reference is available, and leaves a quiet final into a silent agent committed as before.
