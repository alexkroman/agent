---
"@alexkroman1/aai": minor
---

`deepResearchWorkflow()` on `@alexkroman1/aai/experimental` gives you a complete deep-research pass as one `workflow()` definition you register in `agent({ workflows })`. It runs brief, angles, one researcher subagent per angle, a gap pass, a second wave, then the report and a spoken summary. Every stage is a durable step and reports its progress.

- Options: `input` (a schema whose parsed value has `topic`), `prompts` (override any of the seven stage prompts; the defaults are exported as `DEFAULT_DEEP_RESEARCH_PROMPTS`), `researcher` (`builtinTools`, which defaults to `["web_search", "visit_webpage"]`, plus extra `tools` and `llm`), `budget` (`maxAngles`, `maxGapAngles` where `0` skips the gap pass, `concurrency`, `researcherSteps`, `angleAttempts`; defaults in `DEFAULT_DEEP_RESEARCH_BUDGET`) and `generate` (gateway `model`, `apiKeyEnv`, `gatewayUrl`).
- `deliver(result, input, ctx)` runs in the body after the report. It can take its own steps and sleeps, and whatever it returns is the run's output. With no `deliver`, the run's output is the `DeepResearchResult` (`topic`, `brief`, `notes`, `sources`, `report`, `summary`).
- `onFailure(error, input, ctx)` runs when the pass or `deliver` throws. The original error is then re-thrown, so the run still fails with its real reason.
- `citedSources(report, sources)` returns the sources a report actually cites, so you can append real URLs instead of ones a model retyped.
- The step names are `writeBrief`, `planAngles`, `investigate`, `findGaps`, `investigateGap` and `writeReport`, the same ones `research-handoff-agent` used. That template now runs on this factory and is its worked example.
