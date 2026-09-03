// Copyright 2026 the AAI authors. MIT license.
/**
 * What the real `aai-studio-client` build output holds — read the same way
 * `studio-static.ts` resolves it.
 *
 * The shell and favicon routes answer differently depending on whether that
 * package has been built, and a checkout may legitimately be either way. The
 * two route suites used to encode that as `if (res.status === 200) { … } else
 * { expect(res.status).toBe(404) }`, which accepts both outcomes and therefore
 * cannot fail — a `dist` that is absent, a year old, or from another branch
 * all read as healthy, and the package guide's point about a stale bundle
 * looking like NOTHING applies to the tests too.
 *
 * Reading the build state here turns that branch into an EXPECTATION derived
 * from the same bytes the handler serves: deterministic in both environments,
 * and it additionally ties the served shell to the current client build, which
 * nothing did before. `studio-static.test.ts` still owns both branches against
 * a FAKED dist; this is what stops the real-wiring suites from being
 * non-discriminating duplicates of it.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * A file from the studio client's build output, or `null` when the client has
 * not been built. Read per call rather than memoized: the suites ask for two
 * different files and a build is not expected to change mid-run.
 */
export function clientDistFile(rel: string): Buffer | null {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("aai-studio-client/package.json");
  try {
    return readFileSync(path.join(path.dirname(pkgPath), "dist", rel));
  } catch {
    return null;
  }
}

/** The built app shell's exact text, or `null` when the client is not built. */
export function clientShellHtml(): string | null {
  return clientDistFile("index.html")?.toString("utf-8") ?? null;
}
