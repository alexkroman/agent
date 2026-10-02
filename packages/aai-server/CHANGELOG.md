# aai-server

## 0.1.3

### Patch Changes

- d66b0c3: Name the agent sandbox slot states as a discriminated union; validate a reloaded
  guest bundle before swapping it in (a failed reload keeps the old agent
  serving); studio turn step policy as a pure reducer; studio auth as an XState
  machine.
- Updated dependencies [d66b0c3]
- Updated dependencies [f7c51dc]
  - @alexkroman1/aai@0.14.2
  - @alexkroman1/aai-runtime@0.14.2
  - aai-guest@0.6.12

## 0.1.2

### Patch Changes

- aai-guest@0.6.11
  - @alexkroman1/aai@0.14.1
  - @alexkroman1/aai-runtime@0.14.1

## 0.1.1

### Patch Changes

- 5fa348b: Pay down debt-report ledgers: share the cause-chain walk, the runtime-file copy
  and the tool-message list normalizer; drop four `as never` casts behind typed
  seams
- 016e6ee: Slow test tiers are vitest projects selected with --project; no runtime change.
- 8820f2c: Replace truthiness-guarded conditional spreads with explicit presence checks
  (omitUndefined, != null, === true), so an empty-string body forwarded to a guest
  is no longer dropped; guard-invariants rule 22 is now enforced at zero.
- 66953d5: An MCP connect that times out now aborts its in-flight fetches instead of
  leaving them to the SDK's own request timeout. The orchestrator exposes
  `stopSweeps` so a test-built one stops its queue sweep.
- 5fa348b: Give every module a co-located test and remove every vi.mock: collaborators the
  specs used to mock by module are now optional injected seams that default to the
  real implementation
- a9267f2: Model-provider fetch wrappers now take their delegate as a required argument,
  named once by the LLM registry (still the ambient fetch, read per call); agent
  boot artifacts in a contained guest are written under the guest scratch dir
  (/var/tmp) instead of a hardcoded /tmp.
- 3969f74: memoAsync: a build rejecting after reset() no longer evicts the successor build,
  so the next caller joins it instead of starting a redundant third build
- 2dcbe80: Refuse an over-size secret update with a 413 before anything is written: the 64
  KiB env cap is now checked on the merged project record and on every agent's
  merged env, so a refused PUT no longer leaves the value in the project record.
  The per-slug secret PUT and a deploy with an oversized env answer 413 instead of
  500, and a project record already over the cap is applied name-by-name at deploy
  with a warning instead of failing silently.
- Updated dependencies [5fa348b]
- Updated dependencies [f6aa687]
- Updated dependencies [3c0d0dd]
- Updated dependencies [67f7354]
- Updated dependencies [8820f2c]
- Updated dependencies [f869b6a]
- Updated dependencies [b77171d]
- Updated dependencies [66953d5]
- Updated dependencies [dd2e1db]
- Updated dependencies [99400e3]
- Updated dependencies [5fa348b]
- Updated dependencies [5ded42b]
- Updated dependencies [a9267f2]
- Updated dependencies [99400e3]
  - @alexkroman1/aai@0.14.0
  - @alexkroman1/aai-runtime@0.14.0
  - aai-guest@0.6.10

## 0.1.0

History before the `0.x` reset lives in git.
