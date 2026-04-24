import { agent } from "@alexkroman1/aai";
import { memory } from "@alexkroman1/aai/kv";

// Switch to a hosted KV by importing a different factory:
//   import { upstash } from "@alexkroman1/aai/kv";        // UPSTASH_REDIS_REST_URL/_TOKEN
//   import { vercelKV } from "@alexkroman1/aai/kv";       // KV_REST_API_URL/_TOKEN
//   import { cloudflareKV } from "@alexkroman1/aai/kv";   // CLOUDFLARE_*
// or any unstorage driver via:
//   import { unstorage } from "@alexkroman1/aai/kv";
//
// Add a vector store similarly:
//   import { pinecone } from "@alexkroman1/aai/vector";   // PINECONE_API_KEY

export default agent({
  name: "Simple Assistant",
  kv: memory(),
});
