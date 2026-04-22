---
"@alexkroman1/aai": patch
---

Fix PipelineSession: thread agentConfig.maxSteps into streamText via stopWhen: stepCountIs(n). Vercel AI SDK v6 defaults to a single step, so multi-step tool use would silently terminate after the first tool-result.
