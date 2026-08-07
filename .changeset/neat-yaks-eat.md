---
"@alexkroman1/aai": patch
---

Fix preemptive generation killing any turn whose model called a tool after the speculation was adopted. `SpeculativeStream.poisoned()` was consulted once, at the adoption instant, but the speculation is still streaming then — a `tool-call` arriving afterwards reached a tool set built by `toDeclaredTools`, which has no `execute`, so the request died with "Tool result is missing for tool call <id>" and the caller heard `errorPhrase` for a reply the model could have given. An adopted run that turns out to hold a tool call is now abandoned whole and the turn restarts with executable tools; the head start is lost but the turn works.
