---
"@alexkroman1/aai-cli": major
---

`aai start` replaces the scaffold's `server.mjs`, and `aai build --target` emits a host entry instead of committing one.

The scaffold shipped ~300 lines of boot into every project — worker load, env resolution, schema DDL, client-dir probing, error classification, listen, signal handlers — so improving any of them reached only projects scaffolded afterwards. It is a command now: `npm start` runs `aai start`, and `@alexkroman1/aai-cli/start` publishes `createProjectServer()` for a custom or serverless host, which builds the `AgentServer` and binds nothing.

`aai build --target <host>` writes the entry a host expects into the build output rather than the project. The target is detected from the host's own build environment (`VERCEL`), so a git-push deploy configures nothing; `node`, the default, emits nothing extra. The Vercel entry is `export default (await createProjectServer(...)).node`, which is that platform's documented Node WebSocket shape.

Breaking for a scaffolded project: `server.mjs` is gone and `@alexkroman1/aai-cli` moves from devDependencies to dependencies, since `npm start` now runs it.
