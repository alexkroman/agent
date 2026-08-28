---
"@alexkroman1/aai": patch
---

`StaticAgentParams` is derived from the arm `AgentParams` names rather than sharing a third base with it. The shape is identical; what it removes is the second undocumented type on a public signature, which `treatWarningsAsErrors` refuses.
