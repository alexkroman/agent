---
"aai-guest": patch
"aai-server": patch
---

Split this package's `src/` into the two things it is: `harness/` (24 files — the sandbox entry and its modes) and `studio/` (60 — the coding agent), the filename prefix becoming the path. `src/harness.ts` stays at the root beside `harness/` because it is tsdown's one entry, and `limits.ts`, `trial.ts` and `_test-utils.ts` stay because they belong to neither half.

One trap is worth recording for the next such move: a directory URL must keep its TRAILING SLASH. `new URL("../studio-prompts/", import.meta.url)` had to become `"../../studio-prompts/"`, and written without the slash `new URL("agent.md", …)` REPLACES the last segment rather than appending to it — so the shipped studio prompts resolved to `packages/aai-guest/agent.md` and every eval that asked for one failed naming a path nobody wrote. A path-rewriting sweep drops that slash by construction, since `path.relative` does not preserve it.
