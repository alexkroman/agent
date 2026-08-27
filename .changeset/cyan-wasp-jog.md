---
"@alexkroman1/aai-runtime": minor
---

Add the guest's HTTP Storage client and the JSON-with-binary wire codec both sides of platform-owned run storage use. The codec reads a value's raw form before toJSON, which is what carries a Buffer across the wire as bytes instead of {type:"Buffer"} — the Postgres world returns Buffers for every bytea column.
