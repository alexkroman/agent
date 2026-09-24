---
summary: >-
  The fixed release group, what arms a deploy, and how to write a changeset.
read_when: >-
  writing a changeset, or a change has to ship (or must not)
---

# Releases and changesets

## Fixed release coupling

- **`aai`, `aai-ui`, `aai-cli` and `aai-runtime` are one fixed release group**
  (`.changeset/config.json`): a changeset naming one bumps all four.
- **Private packages are versioned too** (`privatePackages: { version: true }`),
  so a changeset may name them; `guard-invariants` rule 20 only rejects that
  when the flag is off. A server-only change ships by naming `aai-server` or
  `aai-studio-server`, and `aai-studio-client` / `aai-guest` changes must name
  one of those as their carrier (`SHIPS_VIA` in
  `scripts/guard-invariants-changesets.mjs`).
- **Nothing in `ship.yml` ships on a merge to `main` — only on a RELEASE**: the
  merged Version Packages PR, detected as a commit that moved a version line in
  a workspace `package.json` (job 1, `changed`). A release also arms `migrate`,
  because `supabase db push` applies whatever is pending. `workflow_dispatch`
  (with `ref`) ships or rolls back a non-release commit.
- **The deploy fires on a server VERSION bump, never on a server source diff**,
  so every production rollout has a release to name. To ship a merged server
  change early, dispatch `ship.yml` with `deploy: true`.
- **Any branch arming `deploy` must arm `migrate`**, and every `ship.yml`
  checkout resolves `github.sha`, never `github.ref`, so one run cannot mix
  commits. `packages/aai-gates/src/ship-workflow-gate.test.ts` pins all of
  this, including that no source-diff arm comes back.
- **`check:deploy-changeset` rejects an EMPTY changeset on a branch that changes
  shipped platform source or `supabase/migrations/**`**, because
  `changeset status` accepts one and the change would otherwise merge and never
  deploy (see `.agents/ratchets.md`).

## Changesets

Every PR that changes `packages/` needs a changeset (the pre-push hook runs
`pnpm changeset status --since=origin/main`). The step-by-step — which package
to name, the bump type, the `pnpm changeset:create` command and the file format
— is the `changeset-release` skill (`.claude/skills/changeset-release/`).
