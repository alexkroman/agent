<!-- Moved out of AGENTS.md so it is read ON DEMAND rather than loaded into
every task's context. AGENTS.md's "Detailed references" table points here. -->

# Releases and changesets

## Fixed release coupling

The four publishable packages — `aai`, `aai-ui`, `aai-cli` and `aai-runtime` —
are one **fixed release group** (configured in `.changeset/config.json`). A
changeset for any one of them bumps all four to the same version. Keep this in
mind when creating changesets — you only need to list one package.

**The PRIVATE packages are versioned too, and a changeset may name them.**
`.changeset/config.json` sets `privatePackages: { version: true, tag: false }`,
and `guard-invariants` rule 20 only rejects naming a private package when that
flag is OFF. So "it is private, therefore it owes an empty changeset" is wrong
— and it was believed for a whole session's worth of `aai-server` work, which
matters because of what that version gates.

**Nothing in `ship.yml` ships on a merge to `main` — only on a RELEASE**, i.e.
the merged Version Packages PR, detected as a commit that moved a version line
in a workspace `package.json`. Job 1 (`changed`) is that gate and every other
job sits behind it, so an ordinary merge updates the PR that will ship it and
stops. Half of it was true by accident already — `changeset pack` packs nothing
when every version is on the registry — but the guest image ran on every push
and pushed a tag to a PUBLIC registry no deploy would ever pin. A release also
arms `migrate` on its own, since `supabase db push` applies what is PENDING and
a schema change merged earlier sits in an earlier commit. `workflow_dispatch`
(with `ref`) ships or rolls back a commit that is not a release; that file's
job-1 comment carries the rest.

**Within a release, the deploy fires on a server VERSION bump, and NOT on a
server source change.** A source-diff arm over `packages/aai-server/src/**` /
`packages/aai-studio-server/src/**` was added (#1343) and is reverted: it made a
production rollout the consequence of a MERGE rather than of a RELEASE, so
every server PR deployed on its own, several times a day — a rolling Modal
rollout plus a migration job each, with no release to name in an incident.
The symptom it was written for is real (#1341 rewrote most of the platform,
moved no version line, and reached production only because a Version Packages
commit happened to land behind it) and the remedy is a CHANGESET: both server
packages are `private`, `privatePackages: { version: true }` means a changeset
may name them and the version really moves, so a server-only change ships the
way everything else does. That is the same model `guard-invariants` rule 20's
`SHIPS_VIA` table is built on, which is why an `aai-studio-client` or
`aai-guest` change must already name a carrier — a server-source diff would
not have covered either. To ship a merged server change without waiting for a
release, dispatch `ship.yml` with `deploy: true`.

Any branch arming `deploy` must arm `migrate` with it, since the deploy job
waits on migrate with a plain condition; `ship-workflow-gate.test.ts` pins that,
that the reverted arm stays reverted, and that the release gate above is a
version line rather than a branch name or a commit subject.

**The half a version gate needs is `check:deploy-changeset`** (see "Quality
ratchets"), because `changeset status` accepts an EMPTY changeset: without it a
branch can change platform source, satisfy every gate, merge, and ship nothing
— which is #1341 reachable again by the front door.

**And every `ship.yml` checkout resolves `github.sha`, never `github.ref`** —
that gate pins this too. A ~20-minute release workflow whose jobs each fetch the
BRANCH TIP ships whatever landed while it ran, and one run published a guest
image from one commit while deploying a server built from another. That file's
header carries the account; the rule is the gate's.

## Changesets

This repo uses [@changesets/cli](https://github.com/changesets/changesets)
to track version bumps. Every PR that changes code in `packages/` **must**
include a changeset file (enforced by the pre-push hook).

**Creating a changeset (interactive — preferred for humans):**

```sh
pnpm changeset          # Prompts for packages + bump type + summary
```

**Creating a changeset (non-interactive — for agents/CI):**

```sh
pnpm changeset:create --pkg @alexkroman1/aai --bump patch --summary "Fix typo in error message"
```

Multiple packages:

```sh
pnpm changeset:create --pkg @alexkroman1/aai --pkg @alexkroman1/aai-ui --bump minor --summary "Add new session API"
```

If the change doesn't need a release (docs-only, config, tests):

```sh
pnpm changeset add --empty
```

**Changeset file format** (`.changeset/<random-name>.md`):

```yaml
---
"@alexkroman1/aai": patch
---

Short summary of the change for the changelog.
```

Valid bump types: `patch` (bug fixes), `minor` (new features), `major`
(breaking changes).

**Fixed packages:** `@alexkroman1/aai`, `@alexkroman1/aai-ui`,
`@alexkroman1/aai-runtime`, and
`@alexkroman1/aai-cli` release together (configured in
`.changeset/config.json`). You only need to list one; the others are
bumped automatically.

**Checking status:** `pnpm changeset status --since=origin/main`
