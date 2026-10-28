---
"@alexkroman1/aai": patch
---

The default prompt now says how to make a "cheapest" or "most expensive" choice:
across every available variant the record lists, holding fixed only what the
caller said must stay, never an unavailable variant, and priced from the chosen
variant's own field. On tau2 retail the model kept the current item's options (a
shoe's size rule applied to every item; a lamp matching the old colour taken
over the cheapest), which was 9 of the 13 writes with wrong arguments in a
114-task run. This is not yet measured by replay.
