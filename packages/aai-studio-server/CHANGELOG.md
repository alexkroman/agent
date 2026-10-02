# aai-studio-server

## 0.11.23

### Patch Changes

- Updated dependencies [d66b0c3]
- Updated dependencies [d66b0c3]
- Updated dependencies [f7c51dc]
  - aai-server@0.1.3
  - @alexkroman1/aai@0.14.2
  - @alexkroman1/aai-runtime@0.14.2
  - aai-studio-client@0.7.8
  - @alexkroman1/aai-ui@0.14.2

## 0.11.22

### Patch Changes

- Updated dependencies [7554cd0]
  - @alexkroman1/aai-ui@0.14.1
  - aai-server@0.1.2
  - aai-studio-client@0.7.7
  - @alexkroman1/aai@0.14.1
  - @alexkroman1/aai-runtime@0.14.1

## 0.11.21

### Patch Changes

- 5fa348b: Pay down debt-report ledgers: share the cause-chain walk, the runtime-file copy
  and the tool-message list normalizer; drop four `as never` casts behind typed
  seams
- 016e6ee: Slow test tiers are vitest projects selected with --project; no runtime change.
- 8820f2c: Replace truthiness-guarded conditional spreads with explicit presence checks
  (omitUndefined, != null, === true), so an empty-string body forwarded to a guest
  is no longer dropped; guard-invariants rule 22 is now enforced at zero.
- 0bc4deb: Studio guest: the end-of-turn TURN-COMPLETE sync now waits for in-flight
  workspace checkpoints, so a stale mid-turn checkpoint can no longer land after
  it; and a session-init for a different project arriving during the sandbox's
  first install is refused instead of being handed a session over the first
  project's tree.
- b77171d: Studio idle reaping binds the sandbox with `await using`, so it is terminated
  even if a release step throws; the remaining hand-rolled waits use the shared
  primitives.
- d6ed79e: Studio client test suites assert through jest-dom matchers and type through
  user-event (test-only; the client's devDependencies change).
- 5fa348b: Give every module a co-located test and remove every vi.mock: collaborators the
  specs used to mock by module are now optional injected seams that default to the
  real implementation
- 2dcbe80: Refuse an over-size secret update with a 413 before anything is written: the 64
  KiB env cap is now checked on the merged project record and on every agent's
  merged env, so a refused PUT no longer leaves the value in the project record.
  The per-slug secret PUT and a deploy with an oversized env answer 413 instead of
  500, and a project record already over the cap is applied name-by-name at deploy
  with a warning instead of failing silently.
- Updated dependencies [5fa348b]
- Updated dependencies [016e6ee]
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
- Updated dependencies [3969f74]
- Updated dependencies [99400e3]
- Updated dependencies [2dcbe80]
  - @alexkroman1/aai@0.14.0
  - aai-server@0.1.1
  - @alexkroman1/aai-runtime@0.14.0
  - aai-studio-client@0.7.6
  - @alexkroman1/aai-ui@0.14.0

## 0.11.20

History before the `0.x` reset lives in git.
