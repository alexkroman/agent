---
"@alexkroman1/aai": minor
---

Add subagents: `subagent()` and `ctx.delegate`.

A subagent is a second tool loop started from inside a tool's `execute` — its
own instructions, model, tools and, above all, its own context window. Only
what it concludes crosses back into the conversation, so a run that reads tens
of thousands of tokens of web pages costs the caller a paragraph. Runs are
ordinary promises, so several fan out with one `Promise.allSettled`.

- `subagent({ name, instructions, llm?, tools?, builtinTools?, maxSteps?, … })`
  declares one; `ctx.delegate(sub, { task, context?, maxSteps? })` runs it and
  answers `{ text, steps, toolCalls }`.
- A subagent's tools run through the same executor as every other tool call —
  argument coercion, schema validation, the per-call deadline, a real
  `ToolContext` — and its last step is spent with tools withheld, so a capped
  run answers instead of stopping mid-chain.
- Delegation is one level deep: a subagent's own tools get a `ctx.delegate`
  that refuses, naming the rule.
- `stubDelegate` (`@alexkroman1/aai/testing`) fakes the capability, routed by
  subagent name; `createToolContext` defaults `delegate` to a rejection.
- The `briefing-desk` template is the worked example.
