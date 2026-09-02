---
"@alexkroman1/aai-runtime": patch
---

Re-take the rollback property's coverage floors at `numRuns: 80`, because two of them were unsatisfiable at 20.

`pipeline-history-rollback-property.test.ts` aggregates its five reach counters across the property's runs, so `numRuns` is what decides how heavy their left tail is. Measured over 24 consecutive runs at 20: `toolHealedAtCap` came out **0 twice** against a floor of `> 10` — a state the corpus simply failed to reach on ~8% of green runs, so no positive floor was settable at all — and `atCapConversation` produced the **144** that failed a real CI job against a floor of 200 whose recorded range started at 442.

Neither recorded range was wrong when it was taken. Twenty draws was too few to describe the unluckiest run, which is the failure mode `AGENTS.md` warns about in the same paragraph that says to floor under the observed minimum: what one script reaches is correlated across all 260 of its steps rather than independent per step.

So the fix is the draw count rather than lower numbers — a floor under a distribution whose minimum is zero cannot be set. Four times the draws costs 635ms → ~2.6s against the unit tier's 5s budget, and it moves `toolHealedAtCap`'s observed minimum from 0 to 672. Every floor is re-taken over 14 consecutive runs at 80 with its new range recorded in place.
