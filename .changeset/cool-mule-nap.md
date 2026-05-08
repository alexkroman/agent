---
"@alexkroman1/aai": patch
---

Fix S2S tool calls arriving with empty args. Strip the $schema keyword from Zod-generated JSON Schema for tool parameters — some S2S providers ship the dialect URI to the underlying model and emit tool calls with empty args even when required params are listed. Also accept both 'arguments' and 'args' field names on the wire. Pipeline transport now surfaces tool-result stream parts as tool_call_done so the client UI flips pending → done.
