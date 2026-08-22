---
"@alexkroman1/aai": major
---

**BREAKING — the host runtime moved to its own package, `@alexkroman1/aai-runtime`.**

`@alexkroman1/aai/runtime` no longer exists. Everything it exported is now the
root export of the new package:

```diff
-import { createAgentServer, createRuntime } from "@alexkroman1/aai/runtime";
+import { createAgentServer, createRuntime } from "@alexkroman1/aai-runtime";
```

Add the dependency alongside `@alexkroman1/aai`; it releases in lockstep, so the
versions always match. A scaffolded project's `server.mjs` is the one place most
users will hit this, and `aai init` now writes it that way.

**Nothing about authoring changed.** `agent()`, `tool()`, `sessionSlot()`,
`workflow()`, the provider factories and every other subpath are untouched. If
your project only contains an `agent.ts` and a `client.tsx`, there is nothing to
migrate.

Why, in one line each:

- **The authoring install sheds 20 dependencies.** `@alexkroman1/aai` went from
  32 runtime dependencies to 12. Every `@ai-sdk/*` adapter, the Deepgram,
  ElevenLabs, Cartesia and AssemblyAI vendor SDKs, plus `ai`, `postgres`, `ws`,
  `ulid` and `@workflow/world-postgres` are the host's, not an agent author's —
  a provider factory returns a pure descriptor and imports no vendor code, so
  they were only ever needed by whatever resolved that descriptor.
- **The API reference shrank 22.7%** (32,334 → 24,999 lines). The runtime is
  ~220 exports against the SDK's ~90, and it was the majority of a reference
  whose readers are people writing agents.

One new subpath comes with it: `@alexkroman1/aai/host-internal`, carrying the
155 SDK internals the runtime needs across the package boundary. Like
`./internal` it is not authoring API and carries no semver promise — it exists
so the runtime can reach them without them landing in an agent author's
autocomplete.
