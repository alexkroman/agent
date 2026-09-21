// Copyright 2026 the AAI authors. MIT license.
/**
 * Turn off zod's JIT, because its FEATURE PROBE is a CSP violation.
 *
 * Zod v4 compiles a specialized parser for each object schema with
 * `new Function`, and decides whether it may by trying one:
 * `try { new Function(""); return true } catch { return false }`
 * (`zod/v4/core/util.js`, `allowsEval`). The studio is served under
 * `script-src 'self'` (`aai-studio-server/studio-static.ts`), so that
 * constructor throws, zod catches it, and every schema falls back to the
 * interpreted parser — nothing breaks.
 *
 * What does not go away is the REPORT. A CSP violation is raised when the
 * policy blocks the operation, not when the page fails to handle it, so a
 * probe written to be caught still fires `securitypolicyviolation` and still
 * lands in DevTools' Issues panel as "blocked the use of eval". Zod's own
 * source names this case at the `jitless` branch. The cost is a permanent
 * warning on a healthy page, which is the kind that trains a reader to skip
 * the panel that is supposed to tell them the CSP caught something real.
 *
 * **This is free rather than a tradeoff**, which is the whole reason to do it
 * here: under this policy the probe already answers `false`, so the JIT is
 * already off and `jitless` only skips asking. It buys back no speed and gives
 * none up. (`zod/compile`, the AOT entry, is not an eval-free alternative — it
 * generates source and calls `new Function` too, and honours this same flag by
 * falling back to the runtime parser.)
 *
 * Set from the APP, never from `aai-ui` or the SDK: `z.config` is global to the
 * zod instance, so a library doing this would silently disable the JIT for a
 * host application whose CSP allows it. Deployed agent pages are served under
 * `AGENT_CSP`, which permits `'unsafe-eval'`, and are unaffected either way.
 *
 * **A side-effect module imported FIRST, and that is the load-bearing part.**
 * The tempting shape is an exported `disableZodJit()` called from `main.tsx`'s
 * body beside `installStaleBuildRecovery()`, and it silently does nothing: zod
 * reads `jitless` in the object schema's INIT, not at parse
 * (`const jit = !globalConfig.jitless` in `$ZodObject`, `v4/core/schemas.js`),
 * so the probe fires when the first `z.object(...)` is CONSTRUCTED.
 * `@alexkroman1/aai/protocol` constructs four at module scope and `api.ts`
 * imports it, so by the time any statement in `main.tsx`'s body runs, ESM has
 * already evaluated that module and the violation is already reported. Only an
 * import that is ordered above the rest is early enough.
 *
 * Biome is what keeps it there: a bare side-effect import is a BARRIER its
 * import sorting will not reorder across (the same reason `import "./styles.css"`
 * sits mid-list in `main.tsx` rather than being sorted into the block above it).
 * `main.test.ts` pins the position, because the failure is silent — the app
 * works either way and only the DevTools warning comes back.
 */

import * as z from "zod";

z.config({ jitless: true });
