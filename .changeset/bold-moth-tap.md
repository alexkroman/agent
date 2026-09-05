---
"aai-server": patch
---

Inject the platform's own span context as `traceparent` on the platform→guest hop, so a model call inside a sandbox joins the trace of the request that caused it. The header is minted from the active span, never relayed from the caller: this hop's callers are the open internet and third-party webhook senders, and forwarding an inbound one would let any of them choose the trace id a tenant's spans are filed under.
