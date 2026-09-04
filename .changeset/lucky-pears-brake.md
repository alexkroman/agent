---
"@alexkroman1/aai-runtime": minor
---

`parseTraceparent` keeps the caller's span id and flags beside the trace id
`traceIdOf` already answered, and is published on
`@alexkroman1/aai-runtime/internal`. One parser, so a log line and an exported
span can never name two different traces for one request.
