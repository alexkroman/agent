---
"@alexkroman1/aai": minor
---

Pluggable KV (memory, upstash, vercelKV, cloudflareKV, generic unstorage) and vector (pinecone) providers via @alexkroman1/aai/kv and @alexkroman1/aai/vector subpath exports. Tools access them via ctx.kv and ctx.vector; the sandbox auto-allowlists each provider's host.
