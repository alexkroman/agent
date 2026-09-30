---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Raise `MAX_TOOL_RESULT_CHARS` from 4000 to 16000. The client's `tool.completed` frame now carries up to 16000 characters of a tool result before it is trimmed with `[truncated]`, and the oversized-result warning fires above 16000. This is a wire change: a client built against the old schema rejects a `tool.completed` frame over 4000 characters, so update the client with the server.
