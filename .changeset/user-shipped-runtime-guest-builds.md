---
"@alexkroman1/aai-cli": minor
"aai-guest": minor
"aai-server": minor
"aai-studio-server": minor
---

Workers ship their own SDK runtime, and all studio builds run in the guest sandbox through the aai CLI's bundlers.

- `buildWorker`'s wrapper entry now bundles the user's installed SDK runtime behind an `__aaiCreateRuntime` export; the guest harness builds sessions through that factory and embeds no runtime of its own, so platform SDK drift can no longer break deployed agents. Bundles without the factory are rejected at `bundle/load`.
- The studio's out-of-process build subsystem (build runner/entry/protocol/cache, the import-allowlist worker build, the host client build, and the `studio_build` Modal Function) is deleted. `test_agent` builds the live workspace in the guest; Publish builds via the new host→guest `workspace/build` RPC, which also returns the bundle's config self-description — no throwaway inspection sandbox on the studio path.
- The guest snapshot image now bakes the build toolchain (`@alexkroman1/aai-cli` + workspace-facing packages) next to the harness; versions derive from aai-guest's own dependencies.
- `MAX_WORKER_SIZE` rises to 30 MB; `evalWorkerBundle` imports workers via a temp `file:` URL (the bundled runtime's CJS interop rejects `data:` URLs); the dev server opts out of runtime inlining to keep watch rebuilds fast.
