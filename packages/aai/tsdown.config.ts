import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

// Derive build entries from package.json exports so they can never drift.
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const entry = [
  ...new Set(
    Object.values(pkg.exports as Record<string, Record<string, string>>)
      .filter(
        (v): v is { "@dev/source": string } =>
          typeof v === "object" && typeof v["@dev/source"] === "string",
      )
      .map((v) => v["@dev/source"].replace(/^\.\//, "")),
  ),
];

export default defineConfig({
  entry,
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  dts: false,
  outExtensions: () => ({ js: ".js" }),
  deps: { neverBundle: [/^[^./]/] },
});
