---
"@alexkroman1/aai": minor
---

Collapse the config-mapping layer into one canonical schema: AgentConfigSchema is now the single serializable agent-config shape flowing CLI -> server -> runtime unchanged. toAgentConfig strips an explicit host-only deny-list (tools, state) instead of copying fields, agent() derives its parameter type from AgentDef instead of re-declaring it, the server's IsolateConfigSchema extends AgentConfigSchema, and toRuntimeAgent passes the whole config through minus wire-only fields (provider descriptors now ride on the runtime agent). Type-level guards enforce each subtraction so a new config field flows everywhere by default.
