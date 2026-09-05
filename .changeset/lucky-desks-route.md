---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Subagents gain `expectedOutput`, a `guardrail` that can send an answer back, and `agent({ subagents })` — a roster the model routes over.

`SubagentDef.expectedOutput` declares what a good final message is and the runtime appends it as its own section, making structural the "tell it to summarize" rule that was previously a sentence every author had to remember. `SubagentDef.guardrail` checks an attempt and may return a complaint, in which case the subagent is re-run with its own rejected answer and that complaint appended to the conversation it already has — so the retry keeps the tool results the first attempt paid for. Exhausting `maxRetries` (default 1) returns the last attempt with `accepted: false` and the `complaint` rather than throwing, because a caller on a live call still has to say something.

`agent({ subagents: [a, b] })` publishes a roster as one `delegate` tool whose `coworker` argument is an enum over the names, described by each subagent's new `description`. It is the other way to choose a subagent: a tool body naming one is the author routing in code, a roster is the model routing per turn. `briefing-desk` demonstrates both side by side.
