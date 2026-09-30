---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

**Per-client MCP servers, and MCP tools from a workflow step.**

- **`McpServerConfig.url` may be a resolver** — `(ctx: McpResolveContext) => string | Promise<string>`, called once per connection with `{ clientId, env, signal }` — for a vendor that mints one MCP session URL per end user. A resolved URL gets the same http(s) check and SSRF screen as a literal, and a status or log line shows only its origin. Types only for readers: code that read `config.url` as a `string` must now handle the function arm (`aai:agent` epoch 16; epoch 15 is retained).
- **`McpServerConfig.headers`** — a record or a resolver — for a server authenticated with something other than a bearer token (`x-api-key`). Host-only in both spellings: `toAgentConfig` never serializes it, and every header named there is stripped when a redirect leaves the server's origin, like `authorization`. A `tokenEnv` bearer still wins an `authorization` clash.
- **`McpServerConfig.allowedTools`** — the remote tool names the agent takes from a server; everything else it publishes is not offered, and an allowed name the server does not publish is logged.
- **`stepMcp(servers, { clientId })`** on `@alexkroman1/aai/experimental`: connect a record of MCP servers for one client from inside a step and get their tools as ordinary `ToolDef`s (`mcp_<key>_<tool>`), ready to spread into `subagent({ tools })` for `stepDelegate`. Close it in the step's `finally`. Unlike host start, an unavailable server REJECTS, so the step's retry policy decides. Published by every `createRuntimeServer` (`aai dev`, `aai start`, a deployed guest); `stubStepMcp(tools)` is the spec-side fake.
- `withMcpTools` calls resolvers with `clientId: undefined`; a per-user server should throw there, which costs that server's tools at host start and nothing else.
