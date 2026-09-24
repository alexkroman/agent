---
name: api-contract-epoch-bump
description: >-
  Use when `pnpm check:api-contracts`, `check:api-report` or `check:docs-md`
  fails, when a change touches a published signature, export or doc comment in
  `aai`, `aai-ui`, `aai-cli` or `aai-runtime`, or when adding a subpath export.
  Walks through regenerating the API reports and markdown reference and
  recording a moved capability hash with `--update`, `--bump --drop` or
  `--bump --retain`.
---

# Recording a change to the published surface

Three committed artifacts describe the published surface, and a change owes
each one it moves. The mechanism and its rules are in `docs/CLAUDE.md`; this is
the procedure.

| Gate | Artifact | Regenerate / record with |
| --- | --- | --- |
| `pnpm check:api-report` | `packages/*/etc/*.api.md`, `API.md`, `API-EXPORTS.json`, `API-INDEX.md` | `pnpm api-report` |
| `pnpm check:api-contracts` | `packages/<pkg>/src/contracts/epochs/<capability>/v<N>.json` (+ `.rollup.txt`) | `node scripts/api-contracts.mjs --update` / `--bump` |
| `pnpm check:docs-md` | `docs/api/**` | `pnpm docs:md` |

Never hand-edit any of them. All three read the BUILT `dist/*.d.ts`, so build
first.

## 1. Build and regenerate the reports

```sh
pnpm build                                # turbo run build
pnpm api-report                           # reports, API.md, API-EXPORTS.json, API-INDEX.md
pnpm docs:md                              # committed markdown reference
```

- A doc-comment-only change owes `pnpm docs:md` (and moves `API-INDEX.md`'s
  summary column via `pnpm api-report`) but never an epoch — the hash strips
  comments.
- A new subpath export defaults INTO all three artifacts and fails until it is
  covered or excused in writing: add its entry point to the package's
  `typedoc.json` (or a reason in `UNDOCUMENTED_SUBPATHS`,
  `scripts/docs-markdown.mjs`), put its exports in a capability (or a reason in
  `NON_AUTHORING_SUBPATHS`, `scripts/_api-contracts-tree.mjs`), and give the
  module an `@module` tag so both renderings name it by its subpath.
- A new unmeasured feature can ship on `@alexkroman1/aai/experimental` first:
  it gets a report but no epoch and no reference page.

## 2. Run the backward-compatibility gate first

```sh
pnpm typecheck
```

The frozen examples under `packages/<pkg>/src/contracts/compatibility/` are
the retained epochs. One it reddens is an OLDER epoch the change breaks;
`--bump --drop` classifies only the current epoch, so drop an older one with
`node scripts/api-contracts.mjs --retire <pkg>:<cap> --epoch N --drop "<reason>"`
(it also deletes that epoch's example). Never edit a frozen example to make it
compile — the error is the finding.

## 3. Read `pnpm check:api-contracts` and record the move

It names each capability whose hash moved and the command that settles it.
Capability names are qualified per package — `aai:tool`, `aai-ui:workflow`,
`aai-runtime:eval`; a bare name works only when unambiguous, and ambiguity is
refused.

```sh
# The probe PROVED the change compatible: record a revision of the same epoch.
node scripts/api-contracts.mjs --update

# Not provably compatible, and the old epoch really breaks: new epoch, and why.
node scripts/api-contracts.mjs --bump aai:tool --drop "<what breaks and for whom>"

# Not provable, but old authoring code still compiles: new epoch, old one retained.
node scripts/api-contracts.mjs --bump aai:tool --retain
```

- `--bump` refuses a change the probe proved compatible; `--update` is the
  answer there.
- `--retain` writes an empty frozen example scaffold at
  `src/contracts/compatibility/<capability>/v<N>.ts` (`.tsx` where the package
  sets `jsx`). Fill it the way that epoch was authored, importing from `..`,
  and make it import every name the retained epoch promised
  (`api-contracts-gate.test.ts` checks this).
- `--drop` deletes the dropped epoch's example.
- One epoch and one revision per capability per BRANCH: re-running on the same
  branch rewrites the branch's epoch in place (measured against the merge-base
  with `origin/main`; `--base <ref|none>` overrides).
- A capability whose promise is a VALUE (e.g. `aai:defaults`' prompt text) is
  not covered by the hash — `--bump` refuses; it is a changeset-and-review
  matter.

If the check instead reports an UNOWNED or FORGOTTEN declaration (a type a
signature reaches that no capability selects, or that no subpath exports), the
remedy is an owner: select the name in the capability it belongs to. The
`unowned-surface.json` / `internal-surface.json` baselines only shrink
(`node scripts/api-contracts.mjs --update-internal` lowers them).

Rarely needed: `--rehash --because "…"` recomputes every current epoch
after a change to the hash RULE (only from a green tree, only in the commit that
changes the rule).

## 4. At a `--bump`, ask what should come OUT

A bump only asks about the names that moved. Read
`packages/aai-templates/template-api-allowlist.json` — the exports no shipped
template exercises — and consider dropping them in the same epoch.

## 5. Changeset

The `check:api-contracts` output suggests a bump type (removed name → `major`,
added → `minor`; anything the probe calls breaking → `major`). Use it in the
changeset — see the `changeset-release` skill.
