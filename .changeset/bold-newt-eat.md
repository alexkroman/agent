---
"@alexkroman1/aai": minor
"aai-server": minor
---

Deploy-time credential preflight: deploys are rejected (400) when the agent's config requires a credential its stored env doesn't hold, derived from the provider descriptors plus the new optional `requiredEnv` field on `agent()`. The studio publishes with a warning instead (it has no secrets UI). `aai dev` now also warns when a required key resolved from the shell only, since it won't survive `aai deploy`.
