---
"@alexkroman1/aai-runtime": patch
"aai-templates": patch
---

Version `@alexkroman1/aai-runtime`'s published surface in epochs, like `aai` and
`aai-ui`. Twelve capabilities — `server`, `runtime`, `session`, `session-state`,
`providers`, `telephony`, `uploads`, `db`, `keys`, `workflow`, `logging`,
`text` — partition all 122 public names, each with a committed epoch and a
frozen, compiling authoring example. `pnpm check:api-contracts` now reports 42
contracts across 3 packages.

The split shipped a published package with no `contracts/` tree, so 221 exports
could move with nothing recording it while its two siblings could not change a
parameter without a gate asking which. `contracts/internal-surface.json` opens
at 68 and may only shrink — the ratchet that took `aai` from 74 to 0.

Two gate-test parsers had never seen shapes this package introduces, and both
reported a healthy tree as broken. A capability whose every name is a type
collapses to `export type { … } from` under Biome, which
`api-contracts-gate.test.ts` read as "declares something of its own" — so
`session` and `session-state`, the two most obviously correct roots, failed. And
an entry point can be ALL re-export (`/internal` passes on 31 names and declares
nothing), which `api-surface-file.test.ts` read as an empty report —
indistinguishable there from a parser that stopped working. The gate tests also
pin the three-way `:workflow` ambiguity now, plus `:session` and `:uploads`,
which is what makes the CLI's refusal to guess load-bearing.
