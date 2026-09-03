---
"@alexkroman1/aai": minor
---

ctx.waitFor and ctx.step take an optional Standard Schema, the first check over the two values a durable workflow body handles that it did not compute. A hook payload arrives over public HTTP and reached the body as a cast; a step's journaled output is read back days later, possibly by a different bundle, and reached it as another. waitFor validates the delivered payload and refuses a bad one fatally, leaving the window as the delivery found it - answered, never reopened, since the same bytes are what every redelivery reads. step validates on BOTH sides of the journal: on the write, where a rejection is the step's own failure and spends an attempt, and on the read, where it is a verdict about the journal in the family of a divergence and journals nothing over a step that succeeded. Durable slot values have been checked structurally in both backends for a long time; a step's output is exactly as durable and had no check at all.
