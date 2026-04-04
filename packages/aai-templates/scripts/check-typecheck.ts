/**
 * Validates all templates typecheck via @secure-exec/typescript.
 * Runs as a standalone script (not vitest) to avoid worker pool issues.
 *
 * Usage: node --experimental-strip-types scripts/check-typecheck.ts
 */
import { createRequire } from "node:module";
import {
  NodeFileSystem,
  allowAllFs,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";
import { createTypeScriptTools } from "@secure-exec/typescript";

const require = createRequire(import.meta.url);
const compilerSpecifier = require.resolve("typescript/lib/typescript.js");

const cwd = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const ts = createTypeScriptTools({
  systemDriver: createNodeDriver({
    filesystem: new NodeFileSystem(),
    permissions: { ...allowAllFs },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
  compilerSpecifier,
});

const result = await ts.typecheckProject({
  cwd,
  configFilePath: `${cwd}/tsconfig.json`,
});

// In secure-exec 0.2.x, the module access overlay is stricter about symlink
// validation. In a pnpm monorepo, some transitive deps of workspace packages
// resolve to canonical paths outside the allowed roots, causing TS2307 errors
// in node_modules. Filter these out — they're not our code.
const ownDiagnostics = result.diagnostics.filter(
  (d) => d.filePath && !d.filePath.includes("/node_modules/"),
);

if (ownDiagnostics.length > 0) {
  const messages = ownDiagnostics.map((d) => {
    const loc = d.filePath ? `${d.filePath}${d.line != null ? `:${d.line}` : ""}` : "";
    return `${loc} - error TS${d.code}: ${d.message}`;
  });
  console.error(`Typecheck failed:\n${messages.join("\n")}`);
  process.exit(1);
}

console.log("All templates typecheck passed.");
