---
"@alexkroman1/aai": minor
---

Add dialog() — a dialog statechart primitive, so what a voice agent may do next is declared rather than asked for in prose. A flow is an xstate machine persisted in a session slot; a flow tool declares the states it may run in and refuses at execution when the conversation is elsewhere, returning a ToolFailure that names where the caller actually is. Every flow tool's result carries the position it landed in, so the active state's instruction reaches the model on every call.
