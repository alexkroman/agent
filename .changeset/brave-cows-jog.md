---
"@alexkroman1/aai": patch
---

Every doc example in the SDK now compiles: a fence whose point is another file (a tool reading a slot from shared.ts, a workflow body beside the agent.ts that declares it, a spec importing the tool it runs) carries that file as // file: sections, which the doc-example gate compiles at their paths. The workflow() docs imported WorkflowContext from a subpath that does not exist; they now import it from the root.
