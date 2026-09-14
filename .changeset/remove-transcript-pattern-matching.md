---
"@alexkroman1/aai": major
"@alexkroman1/aai-runtime": major
---

Remove every layer that decided behaviour by pattern-matching the caller's words.

Four features, one idea: read the caller's transcript with a regex or a phrase list, and change what the agent does. All four are gone.

- **The regex-keyed endpointing table** — `agent({ endpointingRules })`, the five `*EndpointingRule` types, `DEFAULT_ENDPOINTING_RULES`, `matchEndpointingRule`, `clampEndpointingTimeout`, `sdk/endpointing-rules.ts` and the session layer `transports/pipeline-endpointing.ts` that pushed a window to the STT socket mid-stream. `SttSession.updateEndpointing` now has no caller.
- **The two transcript annotations** — `spelledAloudNote`, `assembleSpelledRuns` and `promptingNote`, which appended `[spelled aloud: …]` / `[prompting you for a reply …]` to the MODEL's copy of a user turn. `commitUserTurn` hands the model the verbatim transcript now, which is what the client and history always got.
- **The two barge-in phrase lists** — `acknowledgementPhrases`, `interruptionPhrases`, `DEFAULT_ACKNOWLEDGEMENT_PHRASES`, `DEFAULT_INTERRUPTION_PHRASES`, `classifyBargeInPhrase`, `normalizeBargeInText` and `sdk/barge-in-phrases.ts`. Barge-in now rests only on the content-blind gates, `minBargeInWords` and `interruptionMinDurationMs`; `partialInterrupts` no longer takes the transcript at all.
- **The `smartMatching` voice preset**, the prompt half of the spelled-run annotation. `voicePresets` has three names now.

**The endpointing table is the one with a measurement behind its removal, and it is the reason for the rest.** Two matched 25-task tau2 retail arms differing only in `minTurnSilenceMs` (1600 vs 1200) moved caller-frame latency by **-0.026s against -0.400s expected** (Mann-Whitney p=0.83). The table is why: it RAISED the window above the base on 45/166 turns (27%) at a 1600 base and 79/198 (40%) at 1200 — and at 1200 it raised 11 turns to exactly 1600, turns that needed no raise in the other arm. Retail tau2 is an authentication benchmark, so the rules keyed on spelling, digits and identifier questions fired constantly. A default table that absorbs a knob's entire effect makes the knob unmeasurable, and nothing that shipped had ever been A/B'd against reward.

**What the removals COST is stated rather than discovered.** `minBargeInWords` is 1, chosen when `acknowledgementPhrases` could tell a one-word backchannel from a one-word give-up probe by reading it; with the list gone the two are indistinguishable and both interrupt, and that constant should be revisited on the new basis (recorded at its row in `DEFAULTS-CLAUDE.md`). `smartMatching` was the only thing addressing a name a lookup cannot find — `PROMPT_TOOLS`' retry ladder is the only cover left and was measured to stall on exactly that case. Both gaps are written down in the guides rather than closed.

`assemblyAIS2s({ keyterms })` is untouched: it is a connect-time parameter on the provider's own session config, not a pattern match over a transcript.

Two epochs are DROPPED rather than retained, because a frozen example cannot compile against them: `aai:agent` 8 (an agent declaring any of the removed fields) and `aai:testing` 7 (`AgentConfigSchema`'s published shape lost three keys and a preset value).
