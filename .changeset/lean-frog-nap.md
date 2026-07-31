---
"@alexkroman1/aai": major
---

Remove the Vector store: ctx.vector, the vector: agent field, the @alexkroman1/aai/vector subpath (pinecone/inMemoryVector), the vector/* guest RPC, the platform POST /:slug/vector route, and the platform-owned PINECONE_API_KEY. A future retrieval feature will be a Supabase (pgvector) store following the same path as ctx.db.
