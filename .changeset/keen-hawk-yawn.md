---
"@alexkroman1/aai": minor
---

Widen the authoring surface without moving it: `withDiscoveredTools` is now generic over `ToolBearingAgent` (the parameter widens, the return narrows, no call site changes), which takes `AgentDef` and the sixteen declarations behind it — the zod session-event union included — off the `/testing` contract; and `isRecord`, `omitUndefined` and `responseErrorMessage` join the root barrel, so everything on `@alexkroman1/aai/utils` is reachable from the root too.
