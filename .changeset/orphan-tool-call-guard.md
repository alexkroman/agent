---
"@alexkroman1/aai-runtime": patch
---

A tool call the model made but the AI SDK never executed no longer breaks the
rest of the session. When a step ended on a tool call with an unsafe finish
reason (`length`, `other`, `content-filter` — a gateway that omits
`finish_reason` reads as `other`), the SDK declined to run the call, and the
call was saved to the conversation with no result. Every later turn then failed
with `Tool result is missing for tool call <id>.` until the caller hung up.

Conversation history now pairs every tool call with a result when it is written:
a call nothing executed gets an error result (`"This tool call was not
executed."`), so the model can call it again, and a result with no call is
dropped. The same guard covers `createTextAgent` requests and subagent
revisions. Each repair logs `Orphaned tool call repaired`. The per-turn
`LLM turn` line now names the turn's tool calls and, when a finished step left
one unexecuted, the finish reason, with a warning of its own. An invalid or
failing tool call now logs `Tool call failed` with the tool name and the error.
