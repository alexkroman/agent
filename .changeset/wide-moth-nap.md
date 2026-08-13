---
"@alexkroman1/aai": patch
---

Update dependencies, and fix the scaffold manifest a release would have shipped
unusable.

`aai init` writes `packages/aai-templates/scaffold/package.json` into every new
project, and it is bundled into the `@alexkroman1/aai-cli` tarball to do it.
`scripts/sync-scaffold-versions.mjs` keeps it matching the workspace — and since
shared versions moved into the pnpm catalog, it had been copying the literal
`"catalog:"` into that manifest instead of the range the catalog holds. `catalog:`
is a pnpm workspace protocol with no meaning to npm, so the next release to run
it would have shipped a scaffold that cannot install, failing `aai init` at its
own install step. It resolves the catalog now, refuses any workspace protocol
left in the shipped manifest, and `pnpm check:scaffold` runs in `pnpm check` and
CI — previously the only thing that ran the script at all was the release.

Dependency updates: the six `@ai-sdk/*` providers, `ai` 7.0.62, `assemblyai`,
`@deepgram/sdk`, `@elevenlabs/elevenlabs-js`, `@cartesia/cartesia-js`, `undici`,
`ws`, `hono`, `@hono/node-server`, the three `@supabase/*` clients, `vite` 8.2.1,
and the React type packages; `eventsource-parser` 4, `htmlparser2` 12, and
`jsdom` 30 across the majors.

`ctx.generate`'s structured-output path moved from the AI SDK's `generateObject`,
which `ai` 7.0.62 deprecates, to `generateText` with an `output` setting. The
resolved object and the `{ text, object }` result are unchanged; a generation
that produces no parsable object now surfaces the SDK's `NoOutputGeneratedError`
rather than `NoObjectGeneratedError`.
