# Description

<!-- Brief description of what this PR does -->

## Why

<!-- Why is this change needed? Link to issue: Fixes #123 -->

## How to test

<!-- Steps for reviewers to verify the change -->

- [ ] `pnpm check:local` passes
- [ ] Tests added or updated in the tightest tier that can express them (see
      "Test tiers" in `AGENTS.md`)

## Changeset

<!-- Needed for any change under packages/ — see .github/CONTRIBUTING.md -->

- [ ] Added with
      `pnpm changeset:create --pkg <name> --bump <patch|minor|major> --summary "…"`
- [ ] Empty (`pnpm changeset add --empty`) — nothing under `packages/` ships, or
      the change is internal-only
- [ ] Not needed — nothing under `packages/` or `supabase/migrations/` changed
