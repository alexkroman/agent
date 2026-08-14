---
"@alexkroman1/aai-cli": minor
---

Self-hosting runs the built worker, and a template's `tools/` reach a user's own project.

`npm start` now builds first (a `prestart` script) and `server.mjs` boots
`.aai/worker.mjs` — the same artifact `aai publish` uploads — instead of importing
`agent.ts`. A tool is registered by existing, and that enumeration happens where the
bundle is assembled, so the old entrypoint served an agent with none of its tools and
no error anywhere. `aai build` therefore leaves its worker on disk, `aai eject` writes
`prestart` alongside `start`, and the `registerHooks` shim is gone (the bundle inlines
the `?raw` and attribute-less JSON imports it existed to teach Node).

Fixes five templates — `pizza-ordering`, `plan-desk`, `retail`, `support-line`,
`travel-concierge` — whose specs imported a monorepo-internal path that does not exist
in a scaffolded project, breaking `aai test` and `aai build` for anyone who scaffolded
them. `@alexkroman1/aai/testing` gains **`withDiscoveredTools(def, modules)`**, which is
how a spec in any project gets the def a deployed agent runs:

```ts
const agentDef = withDiscoveredTools(authored, import.meta.glob("./tools/*.ts", { eager: true }));
```

Removes the unused `loadToolModules` from `@alexkroman1/aai/manifest`: there is one way
to build a tool registry, over already-loaded modules, and no runtime directory scan.
