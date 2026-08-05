---
"@alexkroman1/aai-cli": patch
---

Enable the V8 compile cache for the aai bin and drop the redundant --experimental-strip-types NODE_OPTIONS from aai test; pass --singleThreaded to project typechecks (~2x faster under a one-core reservation).
