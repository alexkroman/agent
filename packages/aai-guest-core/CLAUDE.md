# packages/aai-guest-core — shared guest core guide

The five modules both guest modes need (private package). The harness entry and
agent mode are `packages/aai-guest/CLAUDE.md`; the coding agent is
`packages/aai-guest-studio/CLAUDE.md`.

## Why this package exists

**It exists to make the studio/harness split a DAG.** The guest was one
package with a `harness/` and a `studio/` directory, and the two edges between
them point in opposite directions: the entry (`harness.ts`) dispatches studio
mode, and studio reaches back for `rpc`, `types`, `bundle`, `auth` and `http`
at twenty call sites. Two packages therefore cannot express it — whichever one
holds the entry must depend on studio, so studio cannot depend on it — and a
cycle between workspace packages is unbuildable.

Splitting the SHARED five out is what breaks it: core depends on nothing in
this trio, studio depends on core, and `aai-guest` depends on both. The entry
keeps its `./harness` subpath and `dist/harness.mjs`, so `aai-server`'s guest
image pin is untouched.

**The closure is exactly the modules that were shared**, which is what made it
worth doing: `auth`, `bundle`, `http`, `rpc`, `types` pull in nothing else from
the old `harness/`. `trial.ts` (the `run_code`/tool executor) and `limits.ts`
(the shared constants) joined them because all three packages import them —
they sat at `src/` root, so a scan of `harness/` alone missed them.

## `StudioSession` is DECLARED here

`bundle.ts` holds the `studio` slot, and a package that owns a slot owns the
slot's type. It used to be declared beside `startStudioSession` and imported
back as a type — the one core→studio edge, and enough to make the cycle real
even though nothing behavioural crossed. `aai-guest-studio/session`
re-exports both names for the call sites that read them from there.

## `test-utils.ts` carries no underscore, deliberately

`_*.ts` is package-private (Biome's `noPrivateImports`), so a helper three
packages' suites share has to be a real subpath export. Same shape and same
reason as `aai-server/src/test-utils.ts`.

What stayed behind is what cannot come here: `npmResult` fixtures a `runNpm`
result and that function is the studio's, so importing it would point core at
its own dependent; `stubProcessExit` is the entry's, reached only by its
crash-guard specs. Each lives in its own package's `_test-utils.ts`.

## A test follows its subject, and coverage is why

`trial.test.ts`, `bundle.test.ts` and `auth.test.ts` were five `describe`
blocks inside `aai-guest/src/harness.test.ts`. They had to move with the
modules, because **coverage attributes a file to whoever LOADED it**: left
behind, core's modules read as uncovered in core's own report and its floors
would have been seeded at 25% — a ratchet that cannot fail, which is the
failure shape this repo keeps paying for.

The same mechanism bites from the other side. A workspace dependency resolves
to its `src/` through `@dev/source`, so v8 measures a dependency's modules too:
`aai-guest`'s report counted all 60 studio modules and read 27% lines against
a floor of 83. Each package's `vitest.config.ts` excludes its siblings by name
— `include: ["src/**"]` does NOT do it, since the siblings' paths end in `src/`
and match the same glob.
