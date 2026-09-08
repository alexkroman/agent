---

---

Stop the capability epoch gate from demanding a classification for changes that cannot break a consumer.

Two normalizations, applied to the hashed rollup only (`scripts/_api-contracts-hash.mjs`): parameter names are replaced positionally, since TypeScript has no named arguments and a rename cannot make a caller stop compiling; and the body of a declaration another capability of the same package contracts collapses to `// (contracted elsewhere) <Name>`, so a reshape is classified once, on the capability that owns the name, rather than on every capability that happens to reach it.

Measured off the 268 recorded epoch drops: 114 of them (43%) carry a reason admitting the superseded epoch "would in fact still compile", one PR renaming `opts` to `options` forced 36 classifications, and 38% of all hashed declaration lines — 74% of `aai:tool`'s — were another capability's type.

The gate keeps its teeth: the NAME of a foreign declaration is still hashed, so gaining or losing one still bumps; a declaration no capability owns is still hashed by body; a capability's own surface is never elided; and the backward-compatibility test remains the frozen example that `pnpm typecheck` compiles. No published surface changed — the 50 rewritten epoch hashes are a `--rehash` under unchanged epoch numbers, and `contracts/` ships in no tarball.

Separately, every capability's epoch history was deleted and rebuilt at epoch 1. The tree had 361 epoch records and 268 written drop reasons, 55 of which opened with "Pre-release: the SDK has no external consumers, so no superseded authoring style is owed a compiling example" — an epoch is a promise to somebody, and this surface has made none yet. Nothing is retained, so `contracts/compatibility/` is empty by construction and the gate's corpus check now derives that from the contract tables rather than a hand-measured floor. The gate is unchanged in strength: every capability still carries a committed hash and export list, and a surface change still cannot land without `--bump`.
