# packages/aai-guest-studio — studio coding agent guide

The browser studio's coding agent, as it runs inside a guest sandbox (private
package). The harness that dispatches it is `packages/aai-guest/CLAUDE.md`; the
shared guest modules are `packages/aai-guest-core/CLAUDE.md`; the studio
SERVICE that drives it is `packages/aai-studio-server/CLAUDE.md`.

**The agent itself, its tools, its tests and its eval are documented where they
already were**: "The coding agent is an ordinary `agent()`" in
`packages/aai-guest/CLAUDE.md`, and
`packages/aai-guest/CODING-AGENT-TESTS-CLAUDE.md`. This guide is about the
package boundary only.

## What is in here, and what the boundary buys

Everything that was `aai-guest/src/studio/` — 60 files — plus
`studio-prompts/`, the committed copies `scripts/sync-studio-prompt.mjs`
writes. The prompts moved because `_eval-prompt.ts` reads them relative to
itself.

It depends on `aai-guest-core` and is depended on by `aai-guest`, whose entry
dispatches studio mode. That direction is the whole reason core exists — see
"Why this package exists" in that guide.

## Two paths reach OUT of this package, and both are deliberate

- **`toolchain/` stays in `aai-guest`.** The guest image's Docker build context
  is that package, and the Dockerfile `COPY`s `toolchain/package.json` and
  `dist/harness.mjs` from the one context. This package resolves it at RUN time
  by searching upward (`toolchainRoot()` in `build.ts`), so it needs no
  compile-time path; `agent.test.ts` reaches across for it, which is test-only.
- **`project-shape.test.ts` reads `aai-templates/scaffold/`**, a drift gate over
  another package's files. Its two input globs came with it into this package's
  `turbo.json`, because an input glob belongs to whichever package READS the
  file.

## The session scratch directory moved with `build.ts`

`workspacesRoot()` is `path.join(import.meta.dirname, ".workspaces", pid)`, so
a materialized workspace now lands beside THIS package's source. The coding
agent writes `*.test.ts` into a workspace, so a leftover one is collected by
the unit glob and fails this package's suite with somebody else's assertion —
it happened once in `aai-guest`, where a stray fixture whose whole job is to
fail turned `pnpm check` red naming a file no commit contains. The
`src/.workspaces/**` exclude moved with it.
