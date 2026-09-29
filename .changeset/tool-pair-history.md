---
"@alexkroman1/aai-runtime": patch
---

A resumed or reloaded conversation now shows the model its earlier tool calls as real tool calls, each with its result under the same id, followed by what the agent said next. They used to be folded into the agent's own text as `[tool name({…}) → result]` lines, and a model copied the format: in a later turn it spoke tool-call markup (`[tool think(…) … to=functions.prepare_call …`) instead of calling the tool, so the tool never ran.

- A seeded result is capped at 240 characters and a call's arguments at 160 (as JSON; long string arguments are shortened first). A call id that a provider would refuse (not `[A-Za-z0-9_-]`, or over 40 characters) is replaced by a stable one derived from it.
- A call with only one half left in the history (its `tool.called` trimmed off the front of the log, or no result yet) is left out of the model's view. It is no longer described in text.
- `ctx.messages` is unchanged: tools still read each prior result in full.
