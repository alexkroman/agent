---
"@alexkroman1/aai-runtime": patch
---

The model now reads a tool result's collections of same-shaped records as rows.
An array of three or more objects, or an object whose three or more values are
objects (an id-keyed map), whose records share one key set and hold only scalar
values (nested objects of scalars flatten to dotted keys such as
`options.color`) is rendered as a header line plus one line per record, fields
separated by ` | `, every value verbatim and in the original order. Models
misread a field against its neighbours in long nested JSON — picking a minimum
from records flagged unavailable, or swapping a flag between two records — and a
row keeps each record's fields on one line.

Only the copy the model reads changes, for pipeline, text-agent and S2S tools
alike, whether the tool returned an object or a JSON string (a relayed result).
The recorded `role: "tool"` message and the client's `tool.completed` frame
keep the tool's own result. A result with nothing to render, a tool failure,
non-JSON text, or a result over `MAX_TOOL_RESULT_CHARS` reaches the model
exactly as before.
