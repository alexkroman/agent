---
"@alexkroman1/aai": minor
"aai-server": minor
---

Two app modes — agents and workflows: new workflow() definition (audio in, action out: push-to-talk or uploaded audio runs one agentic loop over the sync transport with its own workflow system prompt, rendered by the default client's new run surface), plus ctx.generate (host-executed one-shot LLM generation for tool code, proxied out of the sandbox via the llm/generate guest RPC) and the @alexkroman1/aai/workflow combinators: sequential, parallel, route, orchestrate, evaluatorOptimizer.
