---
name: check
description: Run the local verification gate for the AAI monorepo (the same checks CI runs). Use before committing, pushing, or opening a PR.
disable-model-invocation: true
---

# check

Run the project's canonical verification gate and report the result with the
actual tail of the output — never a summary from memory.

## Steps

1. Pick the right depth:

   ```sh
   pnpm check:local   # fast pre-commit gate — run this before your FIRST commit on a branch
   pnpm check         # full CI-equivalent gate — run before pushing / opening a PR
   ```

   Both run through a single turbo invocation with `--continue`, so every
   failure surfaces at once instead of stopping at the first.

   - Both modes first run the **quality ratchets** (check:hatches,
     check:file-length) up front — fast pure-git/fs gates that fail fast.
   - `check:local` then runs: build, typecheck, lint, check:publint,
     check:syncpack, check:sherif, test, plus check:publish-names.
   - `check` adds: check:attw, check:knip, check:markdown, the type-level tests
     (check:typecheck), check:integration, and check:e2e.

2. If anything fails, fix it and re-run until the script prints
   `All checks passed.` Do not claim success until you see that line.

## The stages that most often surprise an otherwise-clean change

Run `pnpm lint` / `pnpm typecheck` early; these are the ones they *don't* catch:

- **check:syncpack** — a bumped dependency must also be bumped in
  `packages/aai-templates/scaffold/package.json` if it has the same dep.
- **check:publint / check:attw** — a renamed/moved module can leave a
  `package.json` `exports` path dangling; passes dev, fails here.
- **check:knip** — flags unused files/exports/deps.
- **check:hatches** — fails on any net-new static-analysis escape hatch
  (`@ts-expect-error`, `biome-ignore`, `as any`, …) vs the merge base. Fix the
  underlying type/lint error instead of suppressing it.
- **check:file-length** — caps source files at 500 lines, tests at 700
  (grandfathered ceilings in `scripts/file-length-allowlist.json` only ratchet
  down). Split an oversized file rather than raising its ceiling.
- **type-level tests** (`pnpm vitest run --project aai-types`) — changing a
  public API type (`parseManifest`, `Manifest`, …) needs the `.test-d.ts` files
  updated.
- **Changeset** — every PR that changes `packages/` needs a changeset
  (`pnpm changeset:create ...` or `pnpm changeset add --empty`); the pre-push
  hook blocks without one.

## Optional, opt-in suites (not part of check)

Slow and/or credentialed — run only when relevant:

```sh
pnpm test:integration   # real subsystems (Deno sandboxes, HTTP servers)
pnpm test:e2e           # full process spawn + Playwright
./packages/aai-server/guest/docker-test.sh   # gVisor sandbox isolation e2e
```

## Notes

- Single-package shortcuts (`pnpm test:aai-core`, `--filter`, `--project`) are
  fine for tight iteration, but they are **not** the gate — a single-package
  pass does not mean `pnpm check` is green.
- `check:affected` (`pnpm check:affected`) only runs tasks for packages changed
  since `main` — useful for a fast loop, but run the full `pnpm check` before
  pushing.
