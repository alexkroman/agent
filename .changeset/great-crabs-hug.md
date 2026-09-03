---
---

Rewrite the `guard-invariants` timing rules (3, 4, 19, 21, 23, 31) on a real
parse instead of `git grep -E`. Tooling only: no package source changes, so no
release.

The gate now has two engines behind one baseline — a line rule with a POSIX ERE,
and a node rule with a `match(node)` over `oxc-parser` — and a rule keeps its id,
key and budgets across a migration between them. Which kind a new rule should be
is decided by whether it bans a NAME or a SHAPE.

Found by the parse, on shapes the line patterns could not see: two live
`expect.poll` calls Biome had wrapped onto a second line (rule 21 printed
`0 ✓` over them), a hand-rolled sleep in a block-bodied promise executor, and
`aai-ui`'s own `tick()`. Two baseline entries were never violations at all and
are gone. Removes ~150 lines of ERE vocabulary and the `skipComments` machinery
for that family.
