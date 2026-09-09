---
"@alexkroman1/aai": minor
---

Four fixes to the authoring surface, each a case where the docs described behaviour the SDK did not have.

`agent({ llm })` is typed against the gateway model union instead of bare `string`, so a model id autocompletes and a typo is a compile error rather than a 400 at the first live session. `AssemblyAIGatewayModel` is re-exported from the root, following the precedent already recorded for `AssemblyAITtsVoice`. This is a widening — every value that was assignable still is.

An unknown or deprecated AssemblyAI TTS voice now WARNS at config time, naming near catalog ids. A misspelled voice was refused in-band after connect, so the agent came up, reported ready, and never spoke. It warns and never throws: refusing a newly shipped voice the local catalog has not heard of yet would be worse.

`resolveOne` ships the two scorers callers kept writing: `match` (whole-word overlap, filler words skipped) and `code` (compared through `spokenAlphanumeric`), tried as code → ordinal → words. Four shipped templates had four different hand-rolled splitting rules; their disagreements are now tests.

`ToolDef.execute`'s documented 4000-character cap was only ever a CLIENT cap — the model gets the result whole. The comments now say so, and an oversized result warns once per tool with its size, so a forgotten projection is visible instead of silently riding in the prompt on every later turn. Interpolating `DEFAULT_SYSTEM_PROMPT` into your own prompt now warns as well: it never replaced anything, so that recipe shipped ~10,000 duplicate characters per turn.
