// Copyright 2026 the AAI authors. MIT license.
/**
 * Complete a materialized studio workspace into a REAL project — identical
 * in shape to what `aai init` scaffolds, because the guest is a plain Node
 * sandbox and every tool that runs here (`tsc`, Vite, the aai CLI) expects
 * a project: `package.json` for module semantics and agent-installed deps,
 * `tsconfig.json` so builds and publishes are type-checked, `global.d.ts`
 * for Vite's client types, and `vite.config.ts` for the client build's
 * React/Tailwind plugins.
 *
 * Files the workspace already has always win — the coding agent may edit
 * any of these, exactly as a CLI user would.
 *
 * **The contents are COPIED from the scaffold, not retyped.** The same
 * scaffold `aai init` writes ships inside the CLI tarball baked into this
 * image (`@alexkroman1/aai-cli/dist/scaffold`), so the guest reads the real
 * files. It used to hold its own string constants for each one, labelled
 * "mirrors the scaffold" and guarded by a drift TEST — ~500 lines whose whole
 * job was to notice when two copies of one file disagreed. Copying makes the
 * drift impossible rather than detectable, and leaves only the deltas as
 * code: the tsconfig's (vitest types out, test files excluded from the
 * typecheck gate — see {@link workspaceTsconfig}) and the manifest's (exact
 * installed pins rather than the scaffold's carets).
 *
 * There are no exceptions: an existing manifest is the workspace's own and is
 * never rewritten here.
 */

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { toolchainModules } from "./studio-build.ts";

/** True when `p` exists (any kind of entry) — no read, just an access probe. */
export function fileExists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/**
 * The scaffold shipped inside the baked toolchain's CLI tarball, or null when
 * the toolchain is not resolvable.
 *
 * Absence is a degraded mode this module already lives with. It is also not a
 * state worth guarding
 * against here: every consumer of a shaped workspace (the bundlers, the
 * typecheck gate, Publish's `aai deploy`) loads out of that same toolchain, so
 * a workspace missing its shape is one nothing could have built anyway, and
 * the build's own error names the real cause.
 */
export function scaffoldDir(modulesDir: string | null = toolchainModules()): string | null {
  return modulesDir === null
    ? null
    : path.join(modulesDir, "@alexkroman1", "aai-cli", "dist", "scaffold");
}

/** Read one scaffold file, or null when it (or the scaffold) isn't there. */
async function readScaffoldFile(root: string | null, rel: string): Promise<string | null> {
  if (root === null) return null;
  try {
    return await readFile(path.join(root, rel), "utf-8");
  } catch {
    return null;
  }
}

/**
 * The scaffold tsconfig with this workspace's two deltas applied.
 *
 * `types` becomes `["node"]` — the guest builds and typechecks server-side
 * agent code, and vitest's globals are not what a build gate should assert
 * against — and test files leave the typecheck.
 *
 * Tests DO run here (the toolchain carries vitest, and the coding agent is
 * told to write an `agent.test.ts`) — they are kept out of the *typecheck*
 * because that gate runs on every build and Publish. A test that drifted from
 * an edited agent should fail `test_agent`, where the coding agent can see and
 * fix it, not block the user from going live.
 *
 * `strict`, INCLUDING `noImplicitAny` — the scaffold's setting, kept in step
 * here, and it used to be the other way round. The case for switching it off
 * was measured over the starter evals: TS7006 and its siblings (TS7053,
 * TS7034) were 57% of every diagnostic the coding agent had to repair, and not
 * one marked a real defect. That measurement was honest and the conclusion did
 * not survive, for two reasons.
 *
 * The churn it measured was downstream of a receiver that was `any` by design —
 * and the receiver it named, `ctx.state`, NO LONGER EXISTS. A session's state
 * is a `sessionSlot()` now, which is typed, so `state.cart.reduce((sum, p) =>
 * …)` infers both lambda parameters instead of reporting them.
 *
 * And the flag was never only a diagnostic switch. Turning it off also disables
 * evolving-array and evolving-let inference, so `const items = []` is `never[]`
 * from the declaration and `let best = null` is `null` — forever, whatever is
 * assigned later. That is the trap `studio-diagnostics.ts` was written to
 * explain, and one starter spent sixteen type checks on it and never built.
 * Verified both directions on a scratch project: with the flag off those two
 * lines are two errors, with it on they are none. Turning it back on costs zero
 * errors across all twenty-six shipped templates, measured the same way.
 *
 * `useUnknownInCatchVariables` goes for a narrower version of the same reason.
 * Every `catch (err)` in a generated agent ends in "turn this into a string
 * for the model", and an `unknown` binding makes that a two-branch
 * `instanceof` at every site. It cost three repairs in one iteration. What it
 * buys is a degraded message in the rare case something throws a non-Error —
 * cheaper than the ceremony, and `errorMessage()` from the SDK handles it for
 * anyone who cares.
 */
export function workspaceTsconfig(scaffoldTsconfig: string): string {
  const parsed = JSON.parse(scaffoldTsconfig) as {
    compilerOptions?: Record<string, unknown>;
  } & Record<string, unknown>;
  return `${JSON.stringify(
    {
      ...parsed,
      compilerOptions: { ...parsed.compilerOptions, types: ["node"] },
      exclude: ["node_modules", "dist", ".aai", "**/*.test.ts"],
    },
    null,
    2,
  )}\n`;
}

/**
 * The runtime packages the PLATFORM owns — baked into the guest image and
 * resolved from the toolchain `node_modules` above every workspace.
 *
 * A workspace manifest deliberately does NOT declare them. It used to, pinned
 * to the installed versions, purely so they could be READ — and that one
 * documentary choice was expensive: `npm install` reifies whatever manifest it
 * reads, so declaring them made every install re-fetch the whole SDK tree
 * (measured 25s and 156 MB to add one small package, against 451ms and 28 KB
 * without them) and put a workspace-local copy above the baked one. Both
 * readers are served elsewhere — the studio prompt lists what is preinstalled,
 * and `aai pull` fills the manifest in per entry from the scaffold
 * (`mergeScaffoldManifest`), which is where a laptop's versions belong anyway.
 *
 * The list survives because `update_dependencies` still has to refuse to bump
 * one if a workspace names it by hand.
 */
export const WORKSPACE_DEPENDENCIES = [
  "@alexkroman1/aai",
  // A runtime dependency since the self-hosted boot became `aai start`: a
  // scaffolded project's `npm start` runs this package, so it is no longer a
  // devDependency. It is baked into the guest image like the rest of the
  // toolchain, so nothing about the guest changes — what changes is that a
  // workspace naming it by hand must not be able to bump it.
  "@alexkroman1/aai-cli",
  "@alexkroman1/aai-runtime",
  "@alexkroman1/aai-ui",
  "react",
  "react-dom",
  "tailwindcss",
  "xstate",
  "zod",
] as const;

/**
 * Minimal but real: `type: "module"` gives files the same semantics as a
 * scaffolded project, and `npm install <pkg>` records deps here like anywhere
 * else — into an EMPTY dependencies map, so an install only ever fetches what
 * this workspace actually added. See {@link WORKSPACE_DEPENDENCIES} for why
 * the platform's own packages are not listed.
 */
export function workspacePackageJson(): string {
  return `${JSON.stringify(
    { name: "aai-studio-workspace", private: true, type: "module", dependencies: {} },
    null,
    2,
  )}\n`;
}

/**
 * Write any missing project-shape files into `dir`. Existing files win, with
 * no exceptions — the manifest is the workspace's own, and nothing here
 * rewrites it. (It used to: the platform's packages were pinned in and had to
 * be re-pinned on every SDK upgrade, or a stale pin would materialize an old
 * SDK over the baked one. Not declaring them retires both jobs.)
 */
export async function ensureProjectShape(dir: string): Promise<void> {
  const scaffold = scaffoldDir();
  // The scaffold reads are independent; so is every write below.
  const [tsconfig, globalDts, viteConfig, vitestConfig] = await Promise.all([
    readScaffoldFile(scaffold, "tsconfig.json"),
    readScaffoldFile(scaffold, "global.d.ts"),
    readScaffoldFile(scaffold, "vite.config.ts"),
    readScaffoldFile(scaffold, "vitest.config.ts"),
  ]);
  // COPIED verbatim, except where a delta is documented. A file the scaffold
  // does not supply is skipped rather than invented: see {@link scaffoldDir}
  // for why an unshaped workspace is not a state worth papering over.
  const shapeFiles: Record<string, string | null> = {
    "package.json": workspacePackageJson(),
    "tsconfig.json": tsconfig === null ? null : workspaceTsconfig(tsconfig),
    "global.d.ts": globalDts,
    "vite.config.ts": viteConfig,
    "vitest.config.ts": vitestConfig,
  };
  await Promise.all(
    Object.entries(shapeFiles).map(async ([rel, content]) => {
      const abs = path.join(dir, rel);
      if (await fileExists(abs)) return;
      if (content !== null) await writeFile(abs, content, "utf-8");
    }),
  );
}
