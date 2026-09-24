---
name: changeset-release
description: >-
  Use when a branch changes anything under `packages/` or `supabase/migrations/`
  and needs a changeset, when the pre-push hook or `check:deploy-changeset`
  reports a missing or empty changeset, when choosing the bump type, or when a
  change has to reach production (or must not). Covers the fixed release group,
  which private packages ship through which carrier, and what arms a deploy.
---

# Writing a changeset and shipping a change

Every PR that changes code in `packages/` must add a changeset. The pre-push
hook (`lefthook.yml`, `changeset-status`) and `check.yml` run
`pnpm changeset status --since=origin/main`; `check:deploy-changeset` and
`guard-invariants` rule 20 check what the changeset names.

## 1. Decide what the change ships through

| The branch changes | The changeset must name |
| --- | --- |
| `aai`, `aai-ui`, `aai-cli`, `aai-runtime` | any ONE of them — they are a fixed group (`.changeset/config.json` `fixed`), so all four bump to the same version |
| `aai-server` or `aai-studio-server` source, or `supabase/migrations/**` | `aai-server` and/or `aai-studio-server` itself — a dependent bump from an SDK changeset does not count |
| `aai-studio-client` or `aai-guest` | a carrier: `aai-server` or `aai-studio-server` (`SHIPS_VIA` in `scripts/guard-invariants-changesets.mjs`) |
| `aai-templates` | one of the fixed four — the templates ship inside the CLI tarball |
| docs, tests, config only | an empty changeset |

Private packages ARE versioned (`privatePackages: { version: true }`), so a
changeset may name them, and naming a server package is how a server-only
change reaches production. "It is private, so it owes an empty changeset" is
wrong for anything the deploy carries — `check:deploy-changeset` fails a branch
that changes shipped platform source with only an empty changeset. There is no
allowlist; a path that genuinely does not ship belongs in `isShippedSource`
(`scripts/_deploy-changeset-scope.mjs`).

## 2. Pick the bump type

`patch` (fix), `minor` (feature), `major` (break). For a published package,
read the `check:api-contracts` output first: a removed export or a change the
compatibility probe calls breaking is `major` — see the
`api-contract-epoch-bump` skill.

## 3. Write it (non-interactive)

```sh
pnpm changeset:create --pkg @alexkroman1/aai --bump patch --summary "Fix typo in error message"
pnpm changeset:create --pkg aai-server --bump patch --summary "Ship the new sandbox pool"
pnpm changeset:create --pkg @alexkroman1/aai --pkg aai-server --bump minor --summary "…"
pnpm changeset add --empty    # no release needed
```

`pnpm changeset` is the interactive form. The file lands in
`.changeset/<random-name>.md`:

```yaml
---
"@alexkroman1/aai": patch
---

Short summary of the change for the changelog.
```

Check with `pnpm changeset status --since=origin/main`. In a worktree, run
`unset GIT_DIR` first — lefthook sets it and it breaks changeset's repo
detection.

## 4. Know when it deploys

- **Nothing ships on an ordinary merge to `main`.** `ship.yml` ships only on a
  RELEASE: the merged Version Packages PR, detected as a commit that moved a
  version line in a workspace `package.json` (job 1, `changed`).
- **The deploy fires on a server VERSION bump, never on a server source diff**,
  so a production rollout always has a release to name. Do not add a
  source-diff arm back; `ship-workflow-gate.test.ts` pins that it stays gone.
- A release also arms `migrate`; any branch arming `deploy` must arm `migrate`
  (the deploy waits on it).
- Every `ship.yml` checkout resolves `github.sha`, never `github.ref`, so one
  run cannot ship commits that landed while it ran.
- To ship a merged server change without waiting for a release, dispatch
  `ship.yml` with `deploy: true` (and `ref` for a rollback).
