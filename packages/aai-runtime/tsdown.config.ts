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
  // `tokenx` is BUNDLED rather than declared, and the distinction is the
  // consumer's dependency tree. A runtime dependency is transitive — it lands
  // in the tree of everyone who installs this package, which is what
  // `artifact-size-report.mjs` fails a new one over regardless of its bytes.
  // This one is 7.9 kB of single-file MIT ESM with no dependencies of its own
  // and one call site (`transports/pipeline/history/context-budget.ts`), so inlining it
  // costs the tarball almost nothing and costs consumers nothing at all.
  // Its MIT notice is carried in the `banner` below, which is what bundling a
  // third party's code obliges.
  // The carve-out is in the PATTERN, not in `alwaysBundle`: a bare specifier
  // matching `neverBundle` is externalized regardless of `alwaysBundle`, which
  // is verified — with `alwaysBundle: ["tokenx"]` alone the emitted chunk still
  // carried `import { estimateTokenCount } from "tokenx"`.
  deps: { neverBundle: [/^(?!tokenx(?:\/|$))[^./]/] },
  outputOptions: {
    // A provider opener the registry loads lazily (`providers/stt/*.ts`,
    // `providers/tts/*.ts`) becomes a chunk at a STABLE path,
    // `dist/providers/<stage>/<module>.js`, rather than `<module>-<hash>.js`:
    // the CLI's worker bundler names those chunks to leave an undeclared
    // vendor's SDK out of a deploy artifact (`aai-cli/_vendor-openers.ts`), and a
    // hash in the name would make that a pattern match on this file's output.
    // Every other chunk keeps rolldown's default name.
    chunkFileNames: (chunk) => {
      const opener = /\/providers\/(stt|tts)\/([\w-]+)\.ts$/.exec(chunk.facadeModuleId ?? "");
      return opener ? `providers/${opener[1]}/${opener[2]}.js` : "[name]-[hash].js";
    },
    banner: [
      "// This bundle inlines tokenx (https://github.com/johannschopplich/tokenx).",
      "// MIT License. Copyright (c) 2023-PRESENT Johann Schopplich.",
      "// Permission is hereby granted, free of charge, to any person obtaining a copy",
      "// of this software and associated documentation files, to deal in the Software",
      '// without restriction. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF',
      "// ANY KIND. Full text: https://github.com/johannschopplich/tokenx/blob/main/LICENSE",
    ].join("\n"),
  },
});
