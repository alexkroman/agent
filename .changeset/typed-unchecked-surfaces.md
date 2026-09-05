---
"aai-studio-server": patch
---

Close the type-checking gaps: 15 source files were in no `tsc` program at all.

The repo's four type gates reported green with a deliberate `const x: number =
"s"` sitting in ten different files. Each `include` glob was correct on its own
and the seams between them were not:

- **`packages/aai-studio-client/tsconfig.json`** named `vite.config.ts` one by
  one and had fallen behind — `vitest.config.ts` beside it was checked by
  nothing. It is `["src", "*.ts"]` now, which is what every other package uses.
- **Root-level `*.mjs`** belonged to neither root program: `tsconfig.tools.json`
  takes root `*.ts`, `tsconfig.scripts.json` takes `scripts/**` and
  `examples/**`. That left both Stryker configs unchecked — and
  `stryker.sdk.config.mjs` carried a `@type` annotation naming
  `@stryker-mutator/api`, a package the repo never installed, so the annotation
  had never constrained anything. Declared now, and the annotation is live.
- **`scripts/**/*.ts`** was the same seam one file type over: five agent sources
  under `loadtest-stub-agent/` and `loadtest-workflow-agent/` that import the SDK
  and the runtime exactly as a user's `agent.ts` does. Now in
  `tsconfig.tools.json` at full strictness, which found an unsound cast and two
  workflow bodies whose input types disagreed with their zod schemas.
- **The scaffold's `vite.config.ts` and `vitest.config.ts`** ship to every `aai
  init` user and were checked by nothing. `check:template-types` covers them now,
  beside `server.mjs` and for the same reason. The `vitest.config.ts` one matters
  most: it imports `@alexkroman1/aai/testing/vite`, so a rename on our side of
  that subpath breaks every scaffolded project's test run.
- **`aai-server` declared `@types/react` and `@types/react-dom`** and nothing
  read them: it has no `.tsx`, no `jsx` setting, and no `react` dependency, and
  the two scripts that DO read those declarations read them from other packages
  (`sync-guest-toolchain.mjs` from `aai-guest`, `sync-scaffold-versions.mjs`
  from `aai-ui`). Removed. Verified by disabling every `@types` package in the
  workspace one at a time and re-running its own `tsc` — the only other pair
  that survives removal is `aai-guest`'s, which is load-bearing for the guest
  toolchain lockfile rather than for the compiler.
- **The raw Voice Agent API browser example** — 2,200 lines of the reference
  client users read to learn the wire protocol — needs `lib: DOM`, which neither
  root program can offer a Node file. A third program, `tsconfig.browser.json`,
  now checks it; it found 15 unchecked-null DOM reads, a `JSON.parse(null)` on a
  `localStorage` race, and a lost tuple inference.
