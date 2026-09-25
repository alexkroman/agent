---
"@alexkroman1/aai": patch
---

The default voice prompt now resolves a choice the caller defines by pointing
at something else they have ("same as my other one") from THAT record: the
agent opens it instead of asking the caller to recall the value, and never
takes the value from the thing being replaced.
