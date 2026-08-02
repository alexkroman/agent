---
"@alexkroman1/aai": minor
---

Add agent syncState + useAgentState: the agent projects its session state and the client reads it, replacing the hand-rolled return-a-snapshot-from-every-tool pattern. Removes ToolResultMap.
