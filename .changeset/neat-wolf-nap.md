---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
"@alexkroman1/aai-runtime": minor
---

Client tools: `clientTool()` declares a tool the connected browser page runs, and `useClientTool(name, handler)` in aai-ui runs it and returns the handler's result to the model (over the existing `tool.called` / `tool_result` wire pair). `BrowserSession.sendToolResult` is the low-level half.
