---
"@alexkroman1/aai-runtime": minor
---

createAgentServer now forwards the agent env to the server it builds, so AAI_WORKFLOW_API_TOKEN and AAI_SESSION_EVENTS_TOKEN close their routes through that door and DATABASE_URL reaches the upload store (AAI_ALLOW_HOST is filtered out, as in the guest). A malformed upload id answers 400 naming the grammar on every /uploads/:id route instead of 500 on the two reads. SESSION_EVENTS_TOKEN_ENV is exported, so a host can spell the variable that closes that surface.
