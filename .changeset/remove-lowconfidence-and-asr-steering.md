---
"@alexkroman1/aai": major
"@alexkroman1/aai-runtime": major
---

Remove the low-confidence bands and the pipeline ASR-steering seam.

**Neither was ever measured, and both were opt-in, so nothing exercised them.** `agent({ lowConfidence })` and `assemblyAIStt({ keyterms, agentContext })` are off unless an agent declares them, and the benchmark that motivated them declares neither — so across every graded run on this branch the code was carried, documented and never executed. The runtime guide already admitted it: "the value of the steering already shipped has not been measured yet either". Unmeasured is not the same as measured-bad, and removing them is itself unmeasured; what is gone is a surface nobody had evidence for.

What goes with them:

- **`agent({ lowConfidence })`**, `LowConfidencePolicy` / `LowConfidenceAction` / `LowConfidenceStatistic`, the resolver and classifier, the `clarify` / `note` arms, and the `low-confidence` member of `AgentTranscriptRecovery` — a pipeline session now speaks two sentences of its own rather than three.
- **The two word-confidence statistics** (`SttTurnMeta.transcriptConfidence`, `minWordConfidence`) and the per-turn pass over the recognizer's word scores that produced them. Nothing reads them now; `endOfTurnConfidence`, which the endpointing table reads, is untouched.
- **`assemblyAIStt({ keyterms, agentContext })`**, `SttSession.updateKeyterms` / `updateAgentContext`, `SttOpenOptions.agentContext`, the whole `sdk/keyterms.ts` normalizer (the 100-term cap, the 50-character trim, the drop reasons), and the per-turn push at the end of each agent turn.
- **`DialogStateSpec.keyterms`** and `DialogVoiceConfig.keyterms` — a dialog state can no longer narrow the recognizer's vocabulary for one phase.

**`assemblyAIS2s({ keyterms })` STAYS.** It is a different thing that shares a word: a connect-time parameter on the Voice Agent API's own session config, not the pipeline's mid-stream steering. The scaffold guide still teaches it.

The spelled-run annotation stays too, and is now the only thing that annotates the model's copy of a transcript — `modelTranscript` composed it with the low-confidence note and is gone, so `commitUserTurn` applies `spelledAloudNote` directly.

Five epochs are RETIRED or DROPPED rather than retained, because a frozen example is evidence and these cannot compile: `aai:agent` 4 and 7, `aai:dialog` 1, 2 and 3, `aai:stt` 2, `aai:testing` 6. Each entry in `contracts.json` records which declaration it lost.
