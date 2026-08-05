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
 * any of these, exactly as a CLI user would. The contents mirror the
 * scaffold (guarded by studio-project-shape.test.ts against drift), with
 * one deliberate difference: the tsconfig omits vitest types and excludes
 * test files, so a drifted test fails `test_agent` rather than blocking the
 * build and Publish typecheck gate — see WORKSPACE_TSCONFIG below.
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

/** Mirrors packages/aai-templates/scaffold/vite.config.ts (drift-guarded). */
export const WORKSPACE_VITE_CONFIG = `import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
    minify: true,
  },
  ssr: {
    noExternal: true,
  },
});
`;

/**
 * Mirrors packages/aai-templates/scaffold/vitest.config.ts (drift-guarded).
 *
 * Separate from the vite config on purpose — see that file. Vitest prefers
 * this one, so the test run stops depending on the client build's plugin
 * imports resolving, and `globals: true` makes an un-imported `describe`
 * work. Five of the seven repairs in one measured arm were test suites that
 * failed to LOAD (zero assertion failures), which cost a build round each
 * and taught the agent nothing about its own code.
 */
export const WORKSPACE_VITEST_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
});
`;

/** Mirrors the scaffold's global.d.ts (drift-guarded). */
export const WORKSPACE_GLOBAL_DTS = `/// <reference types="vite/client" />
`;

/**
 * The scaffold tsconfig, minus vitest types and with test files excluded.
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
export const WORKSPACE_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2024",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noImplicitAny: false,
      useUnknownInCatchVariables: false,
      verbatimModuleSyntax: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
      resolveJsonModule: true,
      jsx: "react-jsx",
      jsxImportSource: "react",
      lib: ["ES2024", "DOM", "DOM.Iterable"],
    },
    exclude: ["node_modules", "dist", ".aai", "**/*.test.ts"],
  },
  null,
  2,
)}\n`;

/**
 * The runtime packages a workspace writes against — the `dependencies` half
 * of the scaffold's package.json, drift-guarded against it.
 *
 * These already resolve from the toolchain node_modules above the workspace,
 * so declaring them changes no build. They are here to be READ: package.json
 * is the first place any coding agent (or a user who exports the project)
 * looks to learn what it may import, and a manifest declaring nothing said
 * the opposite of the truth. The toolchain-only packages — vite, typescript,
 * the type packages — stay out: the agent never imports them, and every
 * entry here is one more package `npm install` reifies.
 */
const WORKSPACE_DEPENDENCIES = [
  "@alexkroman1/aai",
  "@alexkroman1/aai-ui",
  "react",
  "react-dom",
  "tailwindcss",
  "zod",
] as const;

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
): Record<string, string> {
  if (modulesDir === null) return {};
  const deps: Record<string, string> = {};
  for (const name of WORKSPACE_DEPENDENCIES) {
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
async function reconcileWorkspacePins(abs: string): Promise<void> {
  const installed = resolveWorkspaceDependencies();
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
  const shapeFiles: Record<string, string> = {
    "package.json": workspacePackageJson(),
    "tsconfig.json": WORKSPACE_TSCONFIG,
    "global.d.ts": WORKSPACE_GLOBAL_DTS,
    "vite.config.ts": WORKSPACE_VITE_CONFIG,
    "vitest.config.ts": WORKSPACE_VITEST_CONFIG,
  };
  await Promise.all(
    Object.entries(shapeFiles).map(async ([rel, content]) => {
      const abs = path.join(dir, rel);
      if (await fileExists(abs)) {
        if (rel === "package.json") await reconcileWorkspacePins(abs);
        return;
      }
      await writeFile(abs, content, "utf-8");
    }),
  );
}
