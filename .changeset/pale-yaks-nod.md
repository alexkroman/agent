---
"@alexkroman1/aai-cli": patch
---

The build/deploy typecheck gate now resolves TypeScript from the project's own node_modules by walking up, instead of `require.resolve`, which also consulted Node's global paths (NODE_PATH, ~/.node_modules) and so could typecheck a project against a compiler it never declared.
