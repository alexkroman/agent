---
"@alexkroman1/aai": minor
---

Batch the upload claims: one `PUT …/parts?offset=&offset=…&stored=1` names every window that has landed, instead of one body-less round trip per part.

On the direct path a part was two serialized requests — the window to the platform, then a receipt telling the agent it landed. The receipt carries no bytes and measured 1604-1969 ms against a deployed agent, per part, about half of an upload's wall clock. The client now hands landed offsets to a coalescing claimer (one claim in flight, everything landing during it collapses into one trailing claim, so the batch sizes itself) and a fan-out slot goes straight from its bytes to the next window's. The guest's `recordParts` pays one record read, one lock acquisition and one whole-array write per REQUEST rather than per part, and probes the bucket for every named window concurrently — all-or-nothing, so a batch holding one bad offset records none of itself.

A client only batches when the agent advertised `claimBatch` on the claim; it is never inferred from `directParts`, because an agent reading a single `?offset=` would record the first window and leave the rest as holes that read as silence.

Breaking only for a direct implementor of `UploadStore` from `@alexkroman1/aai/runtime`: `recordPart(id, offset)` is now `recordParts(id, offsets)`.
