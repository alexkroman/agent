---
"@alexkroman1/aai-runtime": patch
---

A tool result's record table now tallies each boolean column in its header —
`12 records (key column: item_id; available: 10 true, 2 false)`. The header used
to give only the row count, and a model asked how many items were available
answered with it ("twelve t-shirt options" for a 12-row table with two
unavailable, twice in one tau2 retail run). Only columns whose every cell is a
JSON boolean are tallied.
