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
 * test files, because agent.test.ts is not runnable in the studio sandbox.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

/** Mirrors the scaffold's global.d.ts (drift-guarded). */
export const WORKSPACE_GLOBAL_DTS = `/// <reference types="vite/client" />
`;

/**
 * The scaffold tsconfig minus vitest (tests don't run here): same
 * strictness, node types for tool code, test files excluded.
 */
export const WORKSPACE_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2024",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
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
 * Minimal but real: `type: "module"` gives files the same semantics as a
 * scaffolded project, and `npm install <pkg>` (the bash tool) records deps
 * here like anywhere else. The aai packages themselves resolve from the
 * toolchain node_modules above the workspace, so they need no entries.
 */
export const WORKSPACE_PACKAGE_JSON = `${JSON.stringify(
  { name: "aai-studio-workspace", private: true, type: "module" },
  null,
  2,
)}\n`;

const SHAPE_FILES: Record<string, string> = {
  "package.json": WORKSPACE_PACKAGE_JSON,
  "tsconfig.json": WORKSPACE_TSCONFIG,
  "global.d.ts": WORKSPACE_GLOBAL_DTS,
  "vite.config.ts": WORKSPACE_VITE_CONFIG,
};

/** Write any missing project-shape files into `dir` (existing files win). */
export async function ensureProjectShape(dir: string): Promise<void> {
  for (const [rel, content] of Object.entries(SHAPE_FILES)) {
    const abs = path.join(dir, rel);
    const exists = await readFile(abs, "utf-8").then(
      () => true,
      () => false,
    );
    if (!exists) await writeFile(abs, content, "utf-8");
  }
}
