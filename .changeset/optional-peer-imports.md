---
"@alexkroman1/aai-runtime": patch
---

Reach every optional OpenTelemetry peer through a dynamic `import()`, so a project that never installed one can still BUILD.

`_tracing-otel.ts` is reached only through the env gate's dynamic `import()`, but a consumer bundles this package with `ssr: { noExternal: true }` and `codeSplitting: false` — `aai build`'s worker, and every deployment target's entry — and both settings together INLINE that import, so the module's own imports had to resolve at the consumer's build time. Vite answers an unresolvable optional peer with `__vite-optional-peer-dep:<peer>`, which exports nothing, and rolldown checks every named binding against it: twelve `[MISSING_EXPORT]` errors, one per name, killed a real `vercel deploy` of a scaffolded project. The same module had done it once before through a different importer, and the remedy both times was to keep it out of that bundle — an invariant over the whole import graph, re-decided by every new caller and checked by nothing.

The peers now arrive as loaded namespaces from `loadOtelPeers()` and are threaded to `startTracingOtel`, `buildIntegration` and the propagator as values; the types come from `import type`, which is erased. Measured against vite 8 / rolldown, a dynamic import is not export-checked in either spelling, so a project without the peers builds clean and meets the existing install line only when it arms `OTEL_*`, while a project that has them gets them inlined and traced exactly as before. The guest still bundles the implementation into `dist/harness.mjs`. No published surface changed.

Two gates hold it: `pnpm check:optional-peers` fails any static value import of an optional peer from a module a published entry can reach (reachability over static AND dynamic edges, since a bundler inlines both), and `aai-cli`'s `_target-bundle-peers.scenario.test.ts` builds a real target entry against a runtime copied out of the workspace with the peers unlinked — the only way to reproduce a user's install, since resolution follows a symlink to its realpath.
