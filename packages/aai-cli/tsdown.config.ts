import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

/**
 * Every subpath export, DERIVED — the same rule `aai-runtime`'s config follows,
 * and for a reason this list paid for: it was hand-written, so adding `./start`
 * to the exports map built nothing and `publint` failed on a subpath pointing
 * at a file that does not exist. A derived list cannot drift.
 *
 * `src/cli.ts` is appended rather than derived: it is the BIN, which the
 * exports map does not name.
 */
const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
  exports: Record<string, Record<string, string>>;
};
const subpaths = Object.values(pkg.exports)
  .map((entry) => entry["@dev/source"])
  .filter((source): source is string => typeof source === "string")
  .map((source) => source.replace(/^\.\//, ""));

export default defineConfig({
  entry: [...new Set(["src/cli.ts", ...subpaths])],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  // Declarations come from `tsc -p tsconfig.build.json`, as in aai/aai-ui.
  // tsdown turns dts on by itself once the exports map declares `types`, and
  // its pass emits a .d.ts next to EVERY file in the program — which, because
  // `@dev/source` resolves cross-package imports to TypeScript source, means
  // stray declarations landing in aai-server and at the repo root.
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  deps: { neverBundle: [/^[^./]/] },
});
