---
"aai-studio-client": patch
"aai-studio-server": patch
---

Stop zod's JIT probe tripping the studio's CSP.

The studio page reports `Content Security Policy of your site blocks the use of 'eval' in JavaScript` against its entry chunk, on every load. Nothing is broken by it, and that is most of the problem: it is a permanent warning on a healthy page, which is exactly the kind that trains a reader to skip the panel that is supposed to tell them the CSP caught something real.

**The probe is zod's, and it is written to be caught.** Zod v4 compiles a specialized parser per object schema with `new Function`, and feature-detects that with `try { new Function(""); return true } catch { return false }` (`allowsEval`, `zod/v4/core/util.js`). `studioCsp` serves `script-src 'self'`, so the constructor throws, zod catches it, and every schema falls back to the interpreted parser. But a CSP violation is raised when the policy BLOCKS the operation, not when the page fails to handle it, so a swallowed throw still fires `securitypolicyviolation` and still lands in the Issues panel. Zod's own source names this case at the `jitless` branch.

`z.config({ jitless: true })` skips the probe. **It is free rather than a tradeoff**, which is the whole argument for doing it: under this policy the probe already answers `false`, so the JIT is already off and the flag only skips asking — measured at 0 `Function` reaches with it and 2 without (the probe, then the fastpass compile), with parsing identical either way. `zod/compile`, the AOT entry, is not an eval-free alternative — it generates source and calls `new Function` too, and honours this same flag by falling back.

**The placement is the load-bearing part, and the obvious spelling is silently wrong.** An exported `disableZodJit()` called from `main.tsx`'s body beside `installStaleBuildRecovery()` does nothing at all: zod reads `jitless` in the object schema's INIT, not at parse (`const jit = !globalConfig.jitless` in `$ZodObject`), so the probe fires when the first `z.object(...)` is CONSTRUCTED — and `@alexkroman1/aai/protocol` constructs four at module scope, which ESM evaluates before any statement in the entry's body. So it is a bare side-effect import ordered above the rest, kept there by Biome's import sorting treating a side-effect import as a barrier (the same reason `import "./styles.css"` sits mid-list rather than being sorted into the block above it).

Set from the APP, never from `aai-ui` or the SDK: `z.config` is global to the zod instance, so a library doing this would silently disable the JIT for a host application whose CSP allows it. Deployed agent pages are served under `AGENT_CSP`, which permits `'unsafe-eval'`, and are unaffected.

Verified in a real browser under the real policy, not only by unit test: the pre-fix build reproduces the reported issue and hashes to `index-C2RNwsIS.js` — the exact chunk from the bug report — and the fixed build loads the same page with the issue gone. `zod-jitless.test.ts` pins three things, each A/B'd by breaking it: the flag, that constructing and parsing an object schema reaches `new Function` zero times (counted through a `Proxy` over the constructor, because what the CSP blocks is the call — `allowsEval` is internal and `cached()`, so it answers from whichever probe ran first), and that `main.tsx` imports the module FIRST. The last is its own test because the failure is silent: the app behaves identically with the import sorted away, and only the DevTools warning comes back.

`aai-studio-server` is named because `aai-studio-client` ships only as a side effect of a server release (`guard-invariants` rule 20).
