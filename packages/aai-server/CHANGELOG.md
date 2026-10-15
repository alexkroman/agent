# aai-server

## 0.2.6

### Patch Changes

- b2e8001: The studio coding agent eval gains a multi-turn case: a follow-up must change
  the tool the first turn built.
- 265e845: The studio coding agent eval names its shipped-prompt copy at
  packages/aai-guest-studio/studio-prompts/, where it moved.
- aai-guest@0.6.20
  - @alexkroman1/aai@0.15.5
  - @alexkroman1/aai-runtime@0.15.5

## 0.2.5

### Patch Changes

- aai-guest@0.6.19
  - @alexkroman1/aai@0.15.4
  - @alexkroman1/aai-runtime@0.15.4

## 0.2.4

### Patch Changes

- 4a291dd: Studio packages reuse shared SDK helpers (runCapped, LogLine/formatLogTime,
  estimateMessageTokens, walkWorkspaceFiles, ai UI-message helpers) instead of
  hand-rolled copies; the studio adopt fetch now aborts on timeout.
- Updated dependencies [4a291dd]
  - @alexkroman1/aai@0.15.3
  - aai-guest@0.6.18
  - @alexkroman1/aai-runtime@0.15.3

## 0.2.3

### Patch Changes

- aai-guest@0.6.17
  - @alexkroman1/aai@0.15.2
  - @alexkroman1/aai-runtime@0.15.2

## 0.2.2

### Patch Changes

- a03cdca: Slim the studio to voice agents only: remove the Voice agent / Workflow project
  kind (one system prompt, one starter list), the API, Workflows and Logs panes,
  the public /studio/api/<slug> page, and the Secrets pane's .env paste box. The
  Twilio and Telnyx webhook URLs move to the Settings pane.
- Updated dependencies [89737d1]
- Updated dependencies [9ed592e]
  - @alexkroman1/aai-runtime@0.15.1
  - aai-guest@0.6.16
  - @alexkroman1/aai@0.15.1

## 0.2.1

### Patch Changes

- 1949e58: Outbound calls pass Twilio signature verification: Modal's proxy unquotes the
  webhook query before it reaches `/:slug/phone`, so the platform now also
  verifies against the query re-encoded the way `stepPlaceCall` built it.

## 0.2.0

### Minor Changes

- 851a4ab: Outbound calls connect on the managed platform: `stepPlaceCall` now dials Twilio
  with a webhook (`<agentUrl>/phone?…`) instead of inline TwiML, the platform's
  `/:slug/phone` and a self-hosted server's new HTTP `/phone` pass the call's
  parameters into the stream, and `agentUrl` defaults to the agent's own public
  URL. `stubPlaceCall` records `webhookUrl` (was `streamUrl`) and takes
  `publicUrl`. `outbound-call-agent` no longer needs `CALLER_AGENT_URL`.

### Patch Changes

- Updated dependencies [851a4ab]
  - @alexkroman1/aai@0.15.0
  - aai-guest@0.6.15
  - @alexkroman1/aai-runtime@0.15.0

## 0.1.5

### Patch Changes

- d266c27: Route `agent({ routes })` on the managed platform: `/:slug/api/*` now forwards
  to the agent's sandbox (per-IP rate limited), so a deployed page's
  `fetch("api/…")` no longer 404s.
- Updated dependencies [d266c27]
  - @alexkroman1/aai@0.14.4
  - aai-guest@0.6.14
  - @alexkroman1/aai-runtime@0.14.4

## 0.1.4

### Patch Changes

- Updated dependencies [d648b81]
  - @alexkroman1/aai@0.14.3
  - aai-guest@0.6.13
  - @alexkroman1/aai-runtime@0.14.3

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
