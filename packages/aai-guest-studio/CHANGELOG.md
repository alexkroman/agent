# aai-guest-studio

## 0.6.6

### Patch Changes

- 350e80f: Split the guest into three packages. `aai-guest-core` holds the seven modules both guest modes need (`rpc`, `types`, `bundle`, `auth`, `http`, plus `trial` — the `run_code`/tool executor — and `limits`), `aai-guest-studio` holds the coding agent's 60 modules and the generated `studio-prompts/`, and `aai-guest` keeps the entry, agent mode, `toolchain/` and `dist/harness.mjs`.
  
  **Three, not two, and the shape is forced.** The entry dispatches studio mode while studio reaches back for the shared five at twenty call sites, so whichever package holds the entry must depend on studio — and studio then cannot depend on it. Two packages could only express that as a cycle, which for workspace packages is unbuildable. The entry has to stay in a package named `aai-guest` because `aai-server` resolves `aai-guest/harness` and bakes the tag into the guest snapshot image, so the shared modules are what moved. Their closure is exactly the modules that were shared, with no transitive pull-in, which is what made it worth doing. `StudioSession` moved into core with them: `bundle.ts` holds the studio-session slot, and a package that owns a slot owns the slot's type — declared in the studio package it was the one core→studio edge, enough to make the cycle real even though nothing behavioural crossed.
  
  `guest-core-package-boundary` and `guest-studio-package-boundary` are what keep the graph a DAG rather than leaving it one, and all eleven boundary deny-lists were regenerated from the tree rather than hand-edited for two new names — `konsistent-config.test.ts` derives the same matrix, and a deny list that goes stale does so by silence.
  
  Nothing changes for `aai-server` or the guest image beyond the tag: tsdown still bundles all three into one self-contained artifact. It is not byte-identical (16,203,601 bytes against 16,193,652 — 0.06% larger, from module ordering and the re-export shim), so the content-addressed image tag moves, exactly as it does for any harness edit.
  
  Five gate floors caught their own corpus shrinking, which is the part worth keeping: `guard-invariants` rule 12's guest scan (18 files against a minimum of 20), `check-deploy-changeset`'s per-package file floor, and the three coverage ratchets. Coverage needed the most care — it attributes a file to whoever LOADED it, so five `describe` blocks moved from `aai-guest/src/harness.test.ts` into core beside the modules they test, and each package's config excludes its siblings by name (`include: ["src/**"]` does not do it: a sibling's path ends in `src/` and matches the same glob). Without that, `aai-guest` measured all 60 studio modules and read 27% lines against a floor of 83. The three suites total 514 tests, exactly what the one package ran.
- Updated dependencies [c129f05]
- Updated dependencies [49daf83]
- Updated dependencies [440e38a]
- Updated dependencies [0dcf247]
- Updated dependencies [440e38a]
- Updated dependencies [b7e21aa]
- Updated dependencies [440e38a]
- Updated dependencies [75f3ea5]
- Updated dependencies [4ab107e]
- Updated dependencies [180fd15]
- Updated dependencies [350e80f]
- Updated dependencies [07a046e]
- Updated dependencies [7832142]
- Updated dependencies [440e38a]
- Updated dependencies [180fd15]
- Updated dependencies [440e38a]
- Updated dependencies [0e12342]
- Updated dependencies [440e38a]
- Updated dependencies [482b874]
- Updated dependencies [f75ad5f]
- Updated dependencies [5ac5edb]
- Updated dependencies [440e38a]
- Updated dependencies [9c1fb03]
- Updated dependencies [9c1fb03]
- Updated dependencies [3e8e8a4]
- Updated dependencies [9c1fb03]
- Updated dependencies [49cebb8]
- Updated dependencies [7fe0571]
- Updated dependencies [350e80f]
  - @alexkroman1/aai@16.2.0
  - @alexkroman1/aai-runtime@16.2.0
  - @alexkroman1/aai-ui@16.2.0
  - @alexkroman1/aai-cli@16.2.0
  - aai-guest-core@0.6.6
