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
 * The one exception to "existing files win" is an existing package.json's
 * toolchain PINS, which are reconciled against what is installed — see
 * `reconcileWorkspacePins` for why a stale pin is a shadowing hazard rather
 * than a cosmetic wart.
 */

import { readFileSync } from "node:fs";
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
 * Absence is a degraded mode this module already lives with — see
 * {@link resolveWorkspaceDependencies}. It is also not a state worth guarding
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
 * `strict` minus `noImplicitAny` — the scaffold's setting, kept in step here.
 * Measured over the starter evals, TS7006 and its siblings (TS7053, TS7034)
 * were 57% of every diagnostic the coding agent had to repair, and not one
 * marked a real defect. They are all downstream of a receiver that is already
 * `any` by design (`ctx.state`, a tool result): `state.cart.reduce((sum, p) =>
 * …)` reports both lambda parameters, and typing them buys nothing, because
 * the body is `any`-checked either way. The rule asks for an annotation
 * without offering any checking in return — pure churn on a gate that blocks
 * publishing. Everything that catches a real mistake (TS2339, TS2345, TS2353
 * — wrong field, wrong argument, wrong option) is unaffected.
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
 * The runtime packages a workspace writes against — the `dependencies` half
 * of the scaffold's package.json.
 *
 * These already resolve from the toolchain node_modules above the workspace,
 * so declaring them changes no build. They are here to be READ: package.json
 * is the first place any coding agent (or a user who exports the project)
 * looks to learn what it may import, and a manifest declaring nothing said
 * the opposite of the truth. The toolchain-only packages — vite, typescript,
 * the type packages — stay out: the agent never imports them, and every
 * entry here is one more package `npm install` reifies.
 */
export const WORKSPACE_DEPENDENCIES = [
  "@alexkroman1/aai",
  "@alexkroman1/aai-ui",
  "react",
  "react-dom",
  "tailwindcss",
  "zod",
] as const;

/**
 * The dependency NAMES the scaffold declares, or the constant above when the
 * scaffold cannot be read. Names rather than versions: the versions come from
 * what is installed (see {@link resolveWorkspaceDependencies}), so this is the
 * one thing worth reading off the scaffold — a package added there reaches a
 * workspace manifest without a second edit here.
 */
function scaffoldDependencyNames(scaffoldManifest: string | null): readonly string[] {
  if (scaffoldManifest === null) return WORKSPACE_DEPENDENCIES;
  try {
    const { dependencies } = JSON.parse(scaffoldManifest) as {
      dependencies?: Record<string, string>;
    };
    const names = Object.keys(dependencies ?? {});
    return names.length > 0 ? names : WORKSPACE_DEPENDENCIES;
  } catch {
    return WORKSPACE_DEPENDENCIES;
  }
}

/**
 * Pin each dependency to the version actually installed in the toolchain.
 *
 * Exact versions, not the scaffold's carets: `add_dependency` runs
 * `npm install <spec>`, which reifies the WHOLE manifest, so a range would
 * let the workspace materialize a different build of the SDK than the one
 * the harness resolved — and a workspace-local node_modules shadows the
 * baked one. Pinned, the local copy is byte-identical and the shadowing is
 * merely redundant. A package we can't read is omitted rather than guessed;
 * a manifest that under-declares is recoverable, one that names a version
 * that doesn't exist breaks every later install.
 */
export function resolveWorkspaceDependencies(
  modulesDir: string | null = toolchainModules(),
  names: readonly string[] = WORKSPACE_DEPENDENCIES,
): Record<string, string> {
  if (modulesDir === null) return {};
  const deps: Record<string, string> = {};
  for (const name of names) {
    try {
      const raw = readFileSync(path.join(modulesDir, name, "package.json"), "utf-8");
      const { version } = JSON.parse(raw) as { version?: string };
      if (typeof version === "string") deps[name] = version;
    } catch {
      // Not installed in this layout — leave it undeclared.
    }
  }
  return deps;
}

/**
 * Minimal but real: `type: "module"` gives files the same semantics as a
 * scaffolded project, and `npm install <pkg>` records deps here like
 * anywhere else.
 */
export function workspacePackageJson(
  dependencies: Record<string, string> = resolveWorkspaceDependencies(),
): string {
  return `${JSON.stringify(
    { name: "aai-studio-workspace", private: true, type: "module", dependencies },
    null,
    2,
  )}\n`;
}

/**
 * Bring an EXISTING manifest's toolchain pins back in line with what is
 * actually installed, leaving everything else — including dependencies the
 * agent added — exactly as it found them.
 *
 * The pins are exact versions read from the toolchain when the manifest was
 * first written. Upgrade the platform's SDK and they go stale, and staleness
 * here is not cosmetic: `add_dependency` runs `npm install`, which reifies the
 * WHOLE manifest, so an old pin materializes an OLD SDK into a
 * workspace-local `node_modules` that then SHADOWS the baked one. The
 * reasoning that made exact pinning safe — the local copy is byte-identical to
 * the baked one, so the shadowing is merely redundant — holds only while the
 * manifest matches the toolchain, which it stops doing the moment the server
 * ships a new SDK. Secondary but real: package.json is the first place the
 * coding agent looks to learn what it may import, and a stale version there is
 * a wrong answer.
 *
 * Only ALREADY-DECLARED entries are rewritten. Absent ones are not added
 * back: `npm install` reifies only what is declared, so an absent entry is not
 * a shadowing hazard, and re-adding one would override a deliberate removal.
 * An unparseable manifest is left alone — the agent may be mid-edit, and
 * `npm install` will report it far better than a silent rewrite would.
 */
async function reconcileWorkspacePins(
  abs: string,
  installed: Record<string, string>,
): Promise<void> {
  if (Object.keys(installed).length === 0) return;
  let manifest: { dependencies?: Record<string, string> } & Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(abs, "utf-8")) as typeof manifest;
  } catch {
    return;
  }
  const declared = manifest.dependencies;
  if (!declared || typeof declared !== "object") return;
  let changed = false;
  for (const [name, version] of Object.entries(installed)) {
    if (name in declared && declared[name] !== version) {
      declared[name] = version;
      changed = true;
    }
  }
  if (changed) await writeFile(abs, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/**
 * Write any missing project-shape files into `dir`. Existing files win, with
 * one exception: an existing package.json has its toolchain pins reconciled
 * against what is installed (see {@link reconcileWorkspacePins}).
 */
export async function ensureProjectShape(dir: string): Promise<void> {
  const scaffold = scaffoldDir();
  // The scaffold reads are independent; so is every write below.
  const [manifest, tsconfig, globalDts, viteConfig, vitestConfig] = await Promise.all([
    readScaffoldFile(scaffold, "package.json"),
    readScaffoldFile(scaffold, "tsconfig.json"),
    readScaffoldFile(scaffold, "global.d.ts"),
    readScaffoldFile(scaffold, "vite.config.ts"),
    readScaffoldFile(scaffold, "vitest.config.ts"),
  ]);
  // One resolution pass for both consumers below — it is a handful of
  // readFileSync + JSON.parse over the toolchain, and every settled write
  // burst reaches here.
  const installed = resolveWorkspaceDependencies(
    toolchainModules(),
    scaffoldDependencyNames(manifest),
  );
  // COPIED verbatim, except where a delta is documented. A file the scaffold
  // does not supply is skipped rather than invented: see {@link scaffoldDir}
  // for why an unshaped workspace is not a state worth papering over.
  const shapeFiles: Record<string, string | null> = {
    "package.json": workspacePackageJson(installed),
    "tsconfig.json": tsconfig === null ? null : workspaceTsconfig(tsconfig),
    "global.d.ts": globalDts,
    "vite.config.ts": viteConfig,
    "vitest.config.ts": vitestConfig,
  };
  await Promise.all(
    Object.entries(shapeFiles).map(async ([rel, content]) => {
      const abs = path.join(dir, rel);
      if (await fileExists(abs)) {
        if (rel === "package.json") await reconcileWorkspacePins(abs, installed);
        return;
      }
      if (content !== null) await writeFile(abs, content, "utf-8");
    }),
  );
}
