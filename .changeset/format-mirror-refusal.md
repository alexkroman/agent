---
"@alexkroman1/aai-runtime": patch
---

A tool argument written in a different shape from every value the conversation's
records have shown for the same field is refused once, naming the records' form
— a state the agent just said aloud as "New York" where the user record holds
`"CO"`, or a ten-digit id sent truncated. Only tight shapes qualify (2-3
capitals, fixed-length digits, `#W`+digits), only an argument of the same kind
is refused (a capitalized name for a capitals field, never `"delivered"` where
one record said `"OK"`), and re-sending the identical value after the refusal
runs it. Each settled result is read whole, so a record too large for the
history's capped copy still counts. On tau2-bench retail it fired 18 times in
6,799 tool calls, all on malformed arguments; at the six leaked address writes
the model's next call used the two-letter form 17 of 24 times on replay.
