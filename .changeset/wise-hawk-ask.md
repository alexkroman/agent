---
"@alexkroman1/aai": minor
---

Add durable workflows built on the Vercel Workflow Development Kit: workflow() declares a schema, description and a "use workflow" body, and ctx.workflows starts and inspects runs. Correlation keys (start(wf, input, { key })) are indexed by the SDK so a voice agent can find a run again after the session that started it is gone.
