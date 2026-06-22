---
name: release-prep
description: Prepare an AAI release — confirm changesets are in place and main is green, then drive the changesets Version Packages → publish flow. Use when cutting a release.
disable-model-invocation: true
---

# release-prep

Get the repo to a verified, releasable state. Releases here are **automated by
the changesets GitHub Action** (`.github/workflows/release.yml`), not by a manual
tag. Stop and report at the first red check — never advance a release on a
failing gate.

## How releases actually happen here

1. Feature PRs land on `main`, **each carrying a changeset** (`.changeset/*.md`).
2. The Release workflow runs on every push to `main`. When unreleased changesets
   exist, the changesets Action opens (or updates) a **"Version Packages"** PR
   that applies the bumps, updates CHANGELOGs, and runs
   `scripts/sync-scaffold-versions.mjs`.
3. **Merging that Version Packages PR** publishes to npm (`pnpm release` →
   `turbo run build && changeset publish`) and, if `packages/aai-server`'s
   version changed, can trigger the Fly.io deploy.

So "cutting a release" is mostly: make sure the changesets are correct and main
is green, then merge the bot's PR.

## 1. Confirm changesets cover what shipped

```sh
pnpm changeset status --since=origin/main
```

- Every package change since the last release must have a changeset. If one is
  missing, add it (`pnpm changeset:create --pkg <package> --bump <patch|minor|major> --summary "…"`).
- Remember the **fixed release group**: `@alexkroman1/aai`,
  `@alexkroman1/aai-ui`, and `@alexkroman1/aai-cli` bump together — listing one
  bumps all three. `aai-server` and `aai-templates` are private and version
  independently.
- Pick the bump from what changed since the last release (patch = fixes,
  minor = features, major = breaking). Ask the user if it's ambiguous.
- In a worktree, `unset GIT_DIR` before running changeset commands (lefthook sets
  it and confuses changeset's repo detection).

## 2. Full gate

```sh
pnpm check
```

Must end with `All checks passed.` The release builds whatever `main` points at,
so `main` must be green before the Version Packages PR is merged.

## 3. Drive the publish

- Ensure all intended feature PRs (with their changesets) are merged to `main`.
- The Release workflow opens/updates the **Version Packages** PR automatically.
  Review its diff — it should be version bumps, CHANGELOG entries, and scaffold
  version sync only, nothing else.
- Merge the Version Packages PR. That merge is what publishes to npm.

## 4. Verify the publish

After the publish job completes, confirm the new versions resolved:

```sh
npm view @alexkroman1/aai version
npm view @alexkroman1/aai-cli version
```

They should match the version in the merged Version Packages PR. If
`packages/aai-server` was bumped, confirm whether a Fly.io deploy was intended
(the workflow detects the version change).

## Notes

- Do not hand-edit versions in `package.json` or hand-create tags — changesets
  owns versioning. Manual bumps drift from the changelog and the fixed group.
- If the publish step fails (e.g. npm auth), it's an Action/secrets issue
  (`NPM_TOKEN`), not something to work around by publishing locally.
