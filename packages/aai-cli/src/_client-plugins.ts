// Copyright 2026 the AAI authors. MIT license.
/**
 * The client build's default Vite plugins, for a project with no
 * `vite.config.*`.
 *
 * Every scaffolded project used to carry a `vite.config.ts` whose whole content
 * was `react()` + `tailwindcss()` and a React Fast Refresh `exclude` — the same
 * file in every project, frozen at the version that scaffolded it. Supplied
 * here instead, a project with a `client.tsx` needs no Vite config at all, and a
 * project WITH one keeps full control: Vite loads it, and nothing here runs.
 *
 * ## The plugins come from the PROJECT, not the CLI
 *
 * `@vitejs/plugin-react` and `@tailwindcss/vite` stay the project's
 * devDependencies (the scaffold declares both whenever a template has a
 * `client.tsx`), resolved from the project root. The CLI does not bundle
 * them: a headless agent — no `client.tsx` — needs neither, and pulling a
 * Tailwind engine into every CLI install to serve the projects that already
 * declare it would put its weight on all of them.
 *
 * ## The Fast Refresh `exclude`
 *
 * {@link REACT_REFRESH_EXCLUDE} is the list the scaffold's config carried, and
 * each entry is load-bearing (see "The client build's default plugins, and Fast
 * Refresh" in this package's guide):
 *
 * - `node_modules` is `@vitejs/plugin-react`'s own default, restated because
 *   passing `exclude` REPLACES it.
 * - `dist/`: a LINKED `aai-ui` resolves to its real path outside
 *   `node_modules`, so without this its bundled chunks became refresh
 *   boundaries and a rebuild threw "Session hooks must be used within
 *   <SessionProvider>" (33 partial updates, 12 invalidations, 8 throws for one
 *   rebuild, measured).
 * - `client.tsx`: the entry MOUNTS, so re-executing it is a second
 *   `mountClient()` on one element. Excluded, an edit to it is one clean page
 *   reload; a component in its own file still fast-refreshes.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginOption } from "vite";
import { CliError } from "./_output.ts";

/** Every file name Vite auto-loads as a project config. */
export const VITE_CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
] as const;

/** The React Fast Refresh `exclude` — see the module doc for each entry. */
export const REACT_REFRESH_EXCLUDE = [/\/node_modules\//, /\/dist\//, /\/client\.tsx$/];

/** The two packages the default client build loads, by role. */
export const CLIENT_PLUGIN_PACKAGES = {
  react: "@vitejs/plugin-react",
  tailwind: "@tailwindcss/vite",
} as const;

/** Whether the project declares its own Vite config (which then wins). */
export function hasViteConfig(cwd: string): boolean {
  return VITE_CONFIG_FILES.some((name) => existsSync(path.join(cwd, name)));
}

type PluginFactory = (options?: Record<string, unknown>) => PluginOption;

/**
 * The directory of package `name` as the PROJECT sees it — the first
 * `node_modules/<name>` walking up from `cwd` — or `undefined`.
 *
 * Walked by hand rather than with `createRequire(cwd).resolve`, which also
 * consults `NODE_PATH`: pnpm's bin shims set it to the store's hoisted
 * `node_modules`, so a project that never declared the plugin would silently
 * build with whatever copy happened to be hoisted there.
 */
function projectPackageDir(cwd: string, name: string): string | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * One plugin factory, resolved from the project and imported — or `undefined`
 * when the project does not have the package.
 */
async function loadFactory(cwd: string, name: string): Promise<PluginFactory | undefined> {
  const dir = projectPackageDir(cwd, name);
  if (dir === undefined) return undefined;
  // A package may name ITSELF through its own `exports` map, so resolving the
  // bare name from inside its directory picks the entry its `exports` declares
  // (both packages export a `default` condition a CommonJS resolve accepts).
  const resolved = createRequire(path.join(dir, "package.json")).resolve(name);
  const mod = (await import(pathToFileURL(resolved).href)) as { default?: unknown };
  return typeof mod.default === "function" ? (mod.default as PluginFactory) : undefined;
}

/**
 * The plugins to build a project's `client.tsx` with, or `undefined` when the
 * project has its own `vite.config.*` and Vite should load that instead.
 *
 * Throws `client_plugins_missing` naming the absent packages: a client built
 * without React's JSX transform or Tailwind would fail far from the cause, or
 * worse, succeed with an unstyled page.
 */
export async function defaultClientPlugins(cwd: string): Promise<PluginOption[] | undefined> {
  if (hasViteConfig(cwd)) return undefined;
  const [react, tailwind] = await Promise.all([
    loadFactory(cwd, CLIENT_PLUGIN_PACKAGES.react),
    loadFactory(cwd, CLIENT_PLUGIN_PACKAGES.tailwind),
  ]);
  if (react === undefined || tailwind === undefined) {
    const missing = [
      ...(react === undefined ? [CLIENT_PLUGIN_PACKAGES.react] : []),
      ...(tailwind === undefined ? [CLIENT_PLUGIN_PACKAGES.tailwind] : []),
    ];
    throw new CliError(
      "client_plugins_missing",
      `client.tsx needs ${missing.join(" and ")} to build, and ${cwd} does not have ${missing.length === 1 ? "it" : "them"}.`,
      `Install ${missing.length === 1 ? "it" : "them"} as a devDependency (\`npm i -D ${missing.join(" ")}\`), ` +
        "or add a vite.config.ts that declares the plugins you want.",
    );
  }
  return [react({ exclude: REACT_REFRESH_EXCLUDE }), tailwind()];
}
