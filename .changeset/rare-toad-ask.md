---
"@alexkroman1/aai-runtime": major
---

AgentServer now exposes the `node:http` server underneath as `node`, so a serverless host can be handed a wired-but-unbound server instead of being asked to start one. Vercel's Node runtime wants `export default <http.Server>` and binds the socket itself; the only route before was to listen on an ephemeral port inside the function and proxy HTTP plus upgrades to it. `port` is now read off that server rather than latched by `listen()`, and `close()` gates on whether the server is listening, so both are correct for a host that bound `node` itself. `createAgentServer` publishes the workflow step env at construction rather than just before the bind, so a deployment that never calls `listen()` does not silently fall back to `process.env` in its steps. Breaking only for a host that IMPLEMENTS `AgentServer`, which must add the member; every consumer of the handle is unaffected.
