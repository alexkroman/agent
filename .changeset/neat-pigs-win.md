---
"@alexkroman1/aai-runtime": patch
---

Platform RPC clients share one HTTP body: a non-2xx whose reply cannot be read now still names the status, and every timeout names the deadline that elapsed.
