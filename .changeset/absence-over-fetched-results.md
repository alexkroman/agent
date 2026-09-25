---
"@alexkroman1/aai": patch
---

The default voice prompt no longer lets the agent say a value the caller calls
"saved" or "on file" isn't there while a result it already fetched holds it: any
fetched result counts, not only the record the caller named, and the value's
parts are taken from that one record — never combined from two.
