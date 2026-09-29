---
summary: >-
  aai-runtime's capabilities and epochs: how a signature change is classified,
  when a capability splits, and the frozen compatibility templates
read_when: >-
  changing a public signature of aai-runtime, adding a capability, or editing
  anything under `src/contracts/`
---

# aai-runtime contracts

## The published surface is versioned in epochs

Each capability under `contracts/entrypoints/` is a named slice of what an
embedder writes against (read the tree for the list — never restate it). The
mechanism is the repo's: see "The authoring surface is versioned in epochs" in
[`docs/CLAUDE.md`](../../../../docs/CLAUDE.md), which owns the reports, the
epochs and the renderings. Here it means a signature change on a contracted
name is RECORDED — `node scripts/api-contracts.mjs --update` when provably
compatible, else `--bump aai-runtime:<capability> --drop "<reason>"` or
`--retain` — rather than discovered by whoever's build breaks.

- **A new feature gets its own capability**, and its own subpath when a
  different reader imports it. Adding a feature to an existing capability makes
  every change to it an epoch of that capability; that is why `auth`, `metrics`,
  `eval-simulate` and `eval-assert` are separate.
- `tools` (one name, `withToolsDir`) is its own capability because it assembles
  the DEFINITION a runtime is handed, not any part of the engine.
- `eval` is the only capability spanning TWO subpaths (`/eval`, `/eval/vitest`).
- Which barrel a name goes on, and the `@internal` rules, are in the package
  guide, "The published surface: two barrels and a rule between them".

## Compatibility templates

**A RETAINED epoch owes a frozen, compiling TEMPLATE** at
`compatibility/<capability>/v<N>.ts`, and `pnpm typecheck` enforces it. Read the
tree for which exist.

- **Never edit a frozen template to make an error go away** — the error IS the
  finding. An API changes by a new epoch carrying a new template.
- **A template, not an example.** This package's consumers embed it (a host, a
  carrier codec, a state backend), so each file is a starter they COPY: composed
  front to back, edit points marked, no design commentary.
- **A template need not exercise every contracted name.** The epoch hash covers
  the capability's whole REPORT, so every name is classification-covered; only
  compile-time exercise is per name. Deliberately absent: `createRuntimeServer`
  / `createHostServer` (a different artifact from the bootstrap) and
  `telnyxCodec` / `twilioCodec` (a third-carrier template is the alternative to
  them). Do not contort a starter into a catalogue.
- What writing the templates found (types whose constructor is `@internal`,
  `WdkAdapter`'s nine methods, `TextTurnResult` and upstream minors) is in
  [`docs/CLAUDE.md`](../../../../docs/CLAUDE.md), "`aai-runtime`
  contract hazards".
