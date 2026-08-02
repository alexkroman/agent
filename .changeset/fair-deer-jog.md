---
"@alexkroman1/aai-ui": patch
---

ToolCallInfo.args carries permissive value types, matching useToolResult: reading a field off a tool call's arguments in a custom client was a compile error, and the cast agents reached for next was rejected as insufficiently overlapping.
