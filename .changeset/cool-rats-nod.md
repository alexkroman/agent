---
"aai-server": minor
---

Platform-default KV can run on Upstash Redis (UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN), falling back to the S3 bucket; redeploys now preserve an agent's platform-default KV data (only agent delete wipes it).
