// Copyright 2026 the AAI authors. MIT license.
/**
 * Re-type-check saved eval workspaces under alternative tsconfigs.
 *
 * The generated agents are the only honest sample of "code a model writes
 * against this SDK", and they are already on disk in the eval results. So a
 * compiler-flag question — does relaxing this rule reduce the errors an agent
 * has to repair, or move them? — can be answered offline, on real code, in
 * seconds, instead of by another hour of live runs.
 *
 * It answered one already: `noImplicitAny: false` was adopted to kill TS7006,
 * and it silently disables evolving-array inference, so every `const xs = []`
 * becomes `never[]` and every push is a TS2345. That is a worse error — the
 * fix is at a declaration the message never mentions, and it re-reports per
 * use site.
 *
 * Module resolution is deliberately NOT set up: the workspaces import
 * `@alexkroman1/aai`, which is not installed in the scratch dir. TS2307 and
 * its knock-on codes are therefore filtered out, and only the inference codes
 * this compares are counted.
 *
 *   node scripts/starter-eval-tsconfig-ab.mjs /tmp/eval-iter8b.json
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The inference codes under comparison; everything else is noise here. */
const COUNTED = /error (TS7006|TS7005|TS7034|TS7053|TS2345|TS2322|TS2339|TS18046)\b/;

const VARIANTS = {
  strict: { strict: true },
  "strict -noImplicitAny": { strict: true, noImplicitAny: false },
  "strict -noImplicitAny -catchUnknown": {
    strict: true,
    noImplicitAny: false,
    useUnknownInCatchVariables: false,
  },
};

const BASE = {
  target: "ES2024",
  module: "ESNext",
  moduleResolution: "bundler",
  noEmit: true,
  skipLibCheck: true,
  jsx: "react-jsx",
  lib: ["ES2024", "DOM", "DOM.Iterable"],
};

const tsc = path.resolve("node_modules/.bin/tsc");

function check(files, compilerOptions) {
  const dir = mkdtempSync(path.join(tmpdir(), "aai-tsab-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      if (rel === "tsconfig.json" || typeof content !== "string") continue;
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { ...BASE, ...compilerOptions } }),
    );
    let out = "";
    try {
      execFileSync(tsc, ["--noEmit", "-p", dir], { encoding: "utf-8" });
    } catch (err) {
      out = String(err.stdout ?? "");
    }
    const codes = {};
    for (const line of out.split("\n")) {
      const m = line.match(COUNTED);
      if (m) codes[m[1]] = (codes[m[1]] ?? 0) + 1;
    }
    return codes;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const file = process.argv[2];
if (!file) throw new Error("usage: starter-eval-tsconfig-ab.mjs <results.json>");
const runs = JSON.parse(readFileSync(file, "utf8")).filter((r) => r.files?.["agent.ts"]);

for (const [label, opts] of Object.entries(VARIANTS)) {
  const total = {};
  for (const run of runs) {
    for (const [code, n] of Object.entries(check(run.files, opts))) {
      total[code] = (total[code] ?? 0) + n;
    }
  }
  const sum = Object.values(total).reduce((a, b) => a + b, 0);
  const detail = Object.entries(total)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}=${n}`)
    .join(" ");
  console.log(`${String(sum).padStart(4)}  ${label.padEnd(38)} ${detail}`);
}
console.log(`\n(${runs.length} workspaces from ${file}; final state, post-repair)`);
