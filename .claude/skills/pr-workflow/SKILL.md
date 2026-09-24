---
name: pr-workflow
description: >-
  Use when finishing a development branch in this repo: before the first
  commit, before pushing, when opening a pull request, when a lefthook
  pre-commit or pre-push hook blocks you, or when working in a git worktree.
  Covers `pnpm check:local`, the common causes of fix-up commits, rebasing on
  origin/main, what the hooks enforce, and worktree gotchas.
---

# Finishing a branch

The default when a branch is done: push it and open a pull request without
asking.

## 1. Before the first commit: `pnpm check:local`

It runs build, typecheck, lint, publint, syncpack, sherif, knip and
`test:coverage` in one turbo call with `--continue`, then NAMES the gates it
skipped (`check:attw`, `check:markdown`, `check:integration`, `check:e2e`,
`docs`) — a green subset is not a green branch. `pnpm check:affected` limits it
to packages changed since `main`.

The five causes of most fix-up commits, and what to do:

1. **Version drift.** Bumping a dependency also owes the scaffold, which
   syncpack does not check: run `pnpm sync:scaffold` (`check:scaffold` fails
   when stale) and usually `pnpm sync:guest-toolchain`
   (`check:guest-toolchain`).
2. **Assertion mismatches.** After changing an output format or error message,
   run `pnpm test` and update the affected assertions.
3. **Lint in untouched files.** Pre-commit lints only staged files; run
   `pnpm lint`.
4. **Type-level tests.** After changing a public API type, run
   `pnpm vitest run --project aai-types` (and the `aai-ui-types` /
   `aai-runtime-types` projects); update the `.test-d.ts` only if the change is
   intended. A published signature change also owes the
   `api-contract-epoch-bump` skill.
5. **Orphaned dependencies.** Deleting the last consumer of a package leaves its
   manifest entry behind. `pnpm check:knip` (in the local subset) reports it,
   plus unused exports on the private packages (`includeEntryExports`). When a
   PR deletes a directory, expect a dependency to come out with it.

Add a changeset (`changeset-release` skill) — the `.claude/settings.json` hook
warns when a commit touches `packages/` without one.

## 2. Commit

Pre-commit (`scripts/pre-commit-format.mjs`) runs `biome check --write` on
staged files and `syncpack lint` when a `package.json` changed. A
PARTIALLY-staged file is skipped (and announced) so formatting cannot stage your
unstaged hunks; format it yourself or CI will fail on it.

## 3. Rebase, then push

```sh
git fetch origin main
git rebase origin/main
```

The pre-push hook (`lefthook.yml`) blocks a push that:

- targets `main`/`master`;
- is behind `origin/main` (rebase first);
- has merge conflicts with `main` (`git merge-tree`);
- changes packages with no changeset (`pnpm changeset status --since=origin/main`);
- fails `pnpm check`.

Never bypass it with `--no-verify`; CI runs the same gates.

## 4. Open the PR, then watch it

After creating the PR, subscribe to its activity and fix CI failures and review
comments until it is green.

## Worktree gotchas

- `unset GIT_DIR` before `pnpm changeset status` — lefthook sets it and it
  confuses changeset's repo detection.
- `pnpm install --frozen-lockfile`; fall back to `pnpm install` only when the
  branch added dependencies.
- Never edit `pnpm-lock.yaml` by hand (a hook blocks it) — run `pnpm install`.
