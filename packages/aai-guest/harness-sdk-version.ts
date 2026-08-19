// Copyright 2026 the AAI authors. MIT license.
/**
 * Which `@alexkroman1/aai` an agent in this guest will actually run.
 *
 * A guest holds TWO copies of the SDK, deliberately: this harness bundles one
 * (`harness.mjs` is a single tsdown artifact, `alwaysBundle: [/.*!/]`), and the
 * agent's runtime comes from the BUNDLE — "so a deployed agent runs exactly the
 * SDK version it was built and tested against; the harness embeds no runtime"
 * (`harness-bundle.ts`). That second copy is the one this reports, because it is
 * the one an agent's code runs.
 *
 * **It is here because its absence cost a whole investigation.** Production
 * answered 500 to a workflow schema failure that answers 400 in-process, and the
 * two candidate causes — "the image baked a stale SDK" and "the two copies
 * disagree about a class identity" — are indistinguishable from outside a
 * sandbox, whose entire boot output was `harness listening on 0.0.0.0:8080`.
 * Nothing a guest printed named a version, so the one question that separates
 * them could not be answered from the logs. (It was the second; see
 * `aai/host/_workflow-request-error.ts`.)
 *
 * Read at boot rather than baked in by a build define, and the choice is the
 * point: a define would report the version the harness was COMPILED against,
 * which is the copy that is NOT in an agent's path.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";

/** The package whose version decides what a deployed agent runs. */
const SDK = "@alexkroman1/aai";

/**
 * Find the SDK's manifest by the node_modules WALK-UP, not by module resolution.
 *
 * Both obvious spellings fail here, and each fails for a reason worth recording:
 *
 * - `require.resolve("@alexkroman1/aai/package.json")` — the SDK's `exports` map
 *   does not publish `./package.json`, so Node refuses the subpath. Adding it
 *   would fix this read and mint a new entry point for `pnpm api-report`, which
 *   derives its report list from that map.
 * - `createRequire(...).resolve("@alexkroman1/aai")` — CJS resolution applies no
 *   custom export condition, and in this workspace the SDK's main is behind
 *   `@dev/source`, so it resolves to nothing (`No "exports" main defined`). The
 *   published tarball is the same shape minus that condition. Verified both ways.
 *
 * The walk-up depends on no exports map at all, and it is not a workaround: it is
 * the SAME resolution the agent's bundle relies on for its own copy —
 * "workspaces are materialized under the same root so their bare imports resolve
 * by the normal node_modules walk-up, exactly as in a user project"
 * (`studio-build.ts`). So this reports the manifest the bundle will load, which a
 * cleverer resolver could disagree with.
 */
function findSdkManifest(from: string): { path: string; version?: unknown } {
  let dir = from;
  for (;;) {
    const path = join(dir, "node_modules", ...SDK.split("/"), "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      // The name check matters: `node_modules` holding a directory of that path
      // whose manifest is something else means the walk should keep going rather
      // than answer with whatever it found first.
      if (isNamed(parsed, SDK))
        return { path, version: isRecord(parsed) ? parsed.version : undefined };
    } catch {
      // Nothing here, or unreadable — keep climbing.
    }
    const up = dirname(dir);
    if (up === dir) throw new Error(`no ${SDK} in any node_modules above ${from}`);
    dir = up;
  }
}

/** Whether a parsed manifest is the package we were looking for. */
function isNamed(parsed: unknown, name: string): boolean {
  return isRecord(parsed) && parsed.name === name;
}

/**
 * The version of the SDK beside the harness, or a sentence saying why not.
 *
 * Never throws. This is called on the boot path purely to describe it, and a
 * harness that refused to listen because it could not read a `package.json` would
 * turn a diagnostic into the outage it exists to explain — the same trade
 * `announcePlatformDbCapacity` makes on the server side.
 *
 * @param from - Directory to walk up from; defaults to this module's own, which
 * after bundling is the directory holding `harness.mjs`. A parameter so a spec can
 * point it at a fixture rather than agreeing with the code's own derivation.
 */
export function guestSdkVersion(from: string = import.meta.dirname): string {
  try {
    const { version } = findSdkManifest(from);
    return typeof version === "string" ? version : "(no version in package.json)";
  } catch (err) {
    // A guest with no SDK beside it is a broken image rather than an impossible
    // state, so the reason is reported rather than swallowed.
    return `(unresolved: ${errorMessage(err)})`;
  }
}
