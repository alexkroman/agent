---
"@alexkroman1/aai": minor
---

Add workflowApp() and a workflow-app arm to AgentParams. A page: "static" agent has no session and no LLM loop, so systemPrompt, tools, maxSteps, state, syncState, the provider triple and the voice knobs were all accepted and inert on one; they are now compile errors naming the rule, and the three voice arms refuse page: "static" from their side. workflowApp({ name, workflows }) is agent() with the discriminant set, returning the same AgentDef.
