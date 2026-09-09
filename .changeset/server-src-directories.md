---
"aai-server": patch
---

Give this package's `src/` five directories. It held 305 TypeScript files and not one subdirectory, so the filename prefix was doing a directory's job: `platform/` (39 files), `sandbox/` (21), `modal/` (15), `guest/` (20) and `microsandbox/` (10) now hold what `platform-*`, `sandbox-*`, `modal-*`, `guest-*` and `microsandbox-*` did. The seven `*-barrel.ts` files stay at the root because they ARE this package's published surface, as do the handlers, the stores and `subprocess-sandbox.ts` — which is deliberately not a contained backend. No exported subpath moved, so `aai-studio-server` imports nothing different.

Three shapes of stale path reference came out of it, and the useful part is that a relative import is a compiler error while none of these is: a spec reading a sibling by BARE filename, a spec whose base is another variable rather than its own directory (deepening that one is wrong — the variable moved with the file), and an `import.meta.glob` WILDCARD, which no existence check can resolve. Two directory scans were also rerooted at `src/` and made recursive; `guest/exec-env.test.ts`'s 120-file floor is what turned its narrowed scan into a failure rather than a rule that had quietly stopped covering most of the package.
