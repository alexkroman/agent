---
"@alexkroman1/aai-runtime": patch
---

Tool arguments are checked against the tool's declared parameters before the
call runs: a missing required parameter, a placeholder (`"unknown"`, `"?"`,
`"n/a"`) standing in for a value, or an undeclared parameter where the schema
sets `additionalProperties: false` is answered with an `invalid_arguments`
result instead of being sent. Host and MCP tool schemas were never enforced, so
these calls reached the tool. A failed call that sent a required string empty is
told so in the model's copy of its result (an empty string is not refused, since
it can be a real answer).
