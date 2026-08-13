---
---

Version the authoring surface in epochs, and record forgotten exports.

Repo tooling and gates only — no published code, and `packages/aai/.npmignore`
keeps the new `contracts/` directory out of the tarball, so the published
artifact is byte-identical.

- `pnpm check:api-contracts` holds twelve capability contracts over the authoring
  API to committed epochs. A signature change now has to be classified —
  retained, which obliges a frozen authoring example that must still compile, or
  dropped with a recorded reason — and the export-list delta suggests the
  changeset bump type instead of leaving it to memory.
- `includeForgottenExports` is on, so a type a public signature mentions but does
  not export is in the reports.
- `API-EXPORTS.json` commits each entry point's export names, so a symbol
  appearing or disappearing is a one-line diff.
- `check:file-length` now measures the 29 top-level `scripts/` files its
  pathspec had never matched.

The text session mode and the workflow wait API landed on main while this was
in flight, so both are already classified: `agent` and `workflow` are at epoch
2, epoch 1 RETAINED in each case, with the epoch-1 examples still compiling as
the evidence.
