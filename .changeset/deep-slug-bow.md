---
"@alexkroman1/aai-runtime": patch
---

Fix a Buffer nested in an array being serialized as Node's own `toJSON` shape instead of a binary envelope on the workflow storage wire. The replacer guarded its holder read with `isRecord`, which excludes arrays, so `{ chunks: [buf] }` crossed as `{type:"Buffer",data:[...]}` and the peer decoded a plain object rather than bytes.
