---
"@alexkroman1/aai": patch
---

Guarantee a hold phrase during tool execution. When the model opens a turn with a tool call and no preceding speech, the pipeline now deterministically speaks a short filler ("One moment.") before the tool runs — so the caller never hears dead air even if the model skips the prompt's tool preamble. Fires at most once per turn and is suppressed when the model already spoke; configurable via the stream handler's `holdPhrase` (set `""` to disable). This also makes tool-first turns produce speech, so they flush cleanly instead of relying on the silent-turn path.
