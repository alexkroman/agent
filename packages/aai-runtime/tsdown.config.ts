import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

// Derive build entries from package.json exports so they can never drift.
const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
  exports: Record<string, Record<string, string>>;
};
const sources = Object.values(pkg.exports)
  .map((v) => v?.["@dev/source"])
  .filter((s): s is string => typeof s === "string")
  .map((s) => s.replace(/^\.\//, ""));
const entry = [...new Set(sources)];

export default defineConfig({
  entry,
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  dts: false,
  // `.js`, not tsdown's default `.mjs`: `package.json` declares
  // `"type": "module"` and the exports map names `./dist/runtime-barrel.js`,
  // which is what publint checks against the packed tarball.
  outExtensions: () => ({ js: ".js" }),
  deps: { neverBundle: [/^[^./]/] },
});
