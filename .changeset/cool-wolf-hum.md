---
"@alexkroman1/aai": patch
---

Move @ai-sdk/* LLM provider packages from optional peerDependencies to dependencies. Self-hosted deployments no longer need to install the @ai-sdk/* packages separately, and prod deploys (where pnpm install --prod previously stripped optional peer deps) now resolve them reliably.
