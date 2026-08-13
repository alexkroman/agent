#!/usr/bin/env node

/**
 * The moving parts behind `api-contracts.mjs`: where a capability's files live,
 * how its synthetic entry point is turned into something API Extractor can
 * analyse, and how the authoring surface is read back out of the committed
 * reports.
 *
 * Split from the gate itself so that file stays the CHECKS — the gate is the
 * part a reader needs to understand, and it should not open with 200 lines of
 * path juggling.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

import { collectExports, reportSource, stripPackageDocumentationMarker } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const { CompilerState, Extractor, ExtractorConfig } = require("@microsoft/api-extractor");

export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const AAI_ROOT = join(ROOT, "packages/aai");
export const CONTRACT_ROOT = join(AAI_ROOT, "contracts");
export const ENTRYPOINT_ROOT = join(CONTRACT_ROOT, "entrypoints");
/** Epoch metadata. NOT `reports/` — `.gitignore` has a bare `reports/` rule. */
export const EPOCH_ROOT = join(CONTRACT_ROOT, "epochs");
export const FIXTURE_ROOT = join(CONTRACT_ROOT, "compatibility");
export const TABLE_PATH = join(CONTRACT_ROOT, "contracts.json");
export const INTERNAL_SURFACE_PATH = join(CONTRACT_ROOT, "internal-surface.json");
const CACHE_ROOT = join(AAI_ROOT, ".api-contracts-cache");

/** Marker a scaffolded fixture carries until somebody writes the real example. */
export const FIXTURE_PLACEHOLDER = "REPLACE_WITH_A_REAL_AUTHORING_EXAMPLE";

export const rel = (path) => relative(ROOT, path);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * Write JSON that Biome already agrees with.
 *
 * `packages/**` is in Biome's file scope, and `JSON.stringify(x, null, 2)` always
 * expands an array while Biome collapses a short one onto its own line —
 * `"supported": [1]`. So every generated file failed `pnpm lint` the moment it was
 * written, and the only fixes available are to hand-edit a file the next run
 * overwrites or to reimplement Biome's formatter and watch it drift. Formatting
 * through Biome itself makes the two agree by construction, which is the same
 * trick eve uses on its own contract metadata (it pipes through `oxfmt`).
 *
 * A formatter failure is not fatal: the raw JSON is still correct and the lint
 * gate will say so in its own words, which is a better error than this one.
 */
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  let formatted = raw;
  try {
    formatted = execFileSync(
      join(ROOT, "node_modules/.bin/biome"),
      ["format", `--stdin-file-path=${path}`],
      { cwd: ROOT, encoding: "utf8", input: raw, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    // Fall through with the unformatted JSON.
  }
  writeFileSync(path, formatted);
};

export const readTable = () => readJson(TABLE_PATH);
export const writeTable = (table) => writeJson(TABLE_PATH, table);
export const readInternalSurface = () => readJson(INTERNAL_SURFACE_PATH);
export const writeInternalSurface = (surface) => writeJson(INTERNAL_SURFACE_PATH, surface);

export const epochPath = (capability, version) => join(EPOCH_ROOT, capability, `v${version}.json`);
export const fixturePath = (capability, version) =>
  join(FIXTURE_ROOT, capability, `v${version}.ts`);
export const readEpoch = (capability, version) => readJson(epochPath(capability, version));
export const writeEpoch = (capability, version, value) =>
  writeJson(epochPath(capability, version), value);

/**
 * The capabilities that EXIST, read off the entry-point directory.
 *
 * Derived rather than listed, for the reason `api-report.mjs` derives its entry
 * points from `package.json#exports`: a hand-kept list of the surface is the
 * thing that goes stale. The gate separately asserts this set matches the
 * contract table, so adding a file without a table entry fails loudly instead
 * of being silently unversioned.
 */
export function capabilities() {
  return readdirSync(ENTRYPOINT_ROOT)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -3))
    .sort();
}

/**
 * The published entry point each source module is reachable through.
 *
 * A capability may only draw from a PUBLISHED subpath, and this is what
 * enforces it: the map is keyed by the `@dev/source` path in
 * `packages/aai/package.json#exports`, so an entry point re-exporting from some
 * internal module resolves to nothing and the extraction fails by name. It also
 * means the contract is extracted from `dist` — the same declarations a
 * consumer installs — while the authored file points at source and therefore
 * type-checks in the ordinary `pnpm typecheck` run.
 */
function publishedSubpaths() {
  const manifest = readJson(join(AAI_ROOT, "package.json"));
  const bySource = new Map();
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target !== "object" || target === null) continue;
    const source = target["@dev/source"];
    const runtime = target.import;
    if (typeof source !== "string" || typeof runtime !== "string") continue;
    bySource.set(resolve(AAI_ROOT, source), { subpath, runtime: resolve(AAI_ROOT, runtime) });
  }
  return bySource;
}

/**
 * One capability entry point, read as data.
 *
 * Entry points are deliberately restricted to `export { … } from "…"` and
 * nothing else. A capability root is a DECLARATION of which names are in the
 * contract; allowing a local type alias or a re-wrapped helper would let the
 * contract's shape be authored here rather than merely selected, and the report
 * would then describe this file instead of the API.
 */
export function parseEntrypoint(capability) {
  const path = join(ENTRYPOINT_ROOT, `${capability}.ts`);
  const source = readFileSync(path, "utf8");
  const ts = createRequire(require.resolve("@microsoft/api-extractor/package.json"))("typescript");
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const groups = [];
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      throw new Error(
        `${rel(path)}: a capability entry point may contain only ` +
          '`export { … } from "…"` statements — it selects names from a published ' +
          "subpath, it does not declare any of its own.",
      );
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.exportClause.elements.map((element) => {
      const name = element.name.text;
      if (element.propertyName !== undefined) {
        throw new Error(
          `${rel(path)}: ${element.propertyName.text} is renamed to ${name}; a contract may not rename.`,
        );
      }
      if (names.has(name)) throw new Error(`${rel(path)}: ${name} is exported twice.`);
      names.add(name);
      return { name, isTypeOnly: statement.isTypeOnly || element.isTypeOnly };
    });
    groups.push({ specifier, source: resolve(dirname(path), specifier), clause });
  }
  if (groups.length === 0) throw new Error(`${rel(path)}: exports nothing.`);
  return { capability, path, groups, names };
}

/**
 * The `.d.ts` twin of a capability entry point, pointing at `dist`.
 *
 * API Extractor analyses declarations, and the declarations that matter are the
 * emitted ones. The authored file cannot be used directly for two reasons: it
 * is `.ts`, and it names source modules, so a report built from it would
 * describe what the repo compiles rather than what a consumer installs.
 */
function writeCapabilityEntry(entry, outputDir) {
  const bySource = publishedSubpaths();
  const path = join(outputDir, `${entry.capability}.d.ts`);
  const blocks = entry.groups.map((group) => {
    const published = bySource.get(group.source);
    if (published === undefined) {
      throw new Error(
        `${rel(entry.path)}: "${group.specifier}" is not a published entry point of ` +
          "@alexkroman1/aai. A capability may only draw from a subpath in that package's " +
          "`exports` map — otherwise the contract covers something no consumer can import.",
      );
    }
    const clause = group.clause
      .map(({ name, isTypeOnly }) => `  ${isTypeOnly ? "type " : ""}${name},`)
      .join("\n");
    let target = relative(outputDir, published.runtime).replaceAll("\\", "/");
    if (!target.startsWith(".")) target = `./${target}`;
    return `export {\n${clause}\n} from "${target}";`;
  });
  writeFileSync(path, `${blocks.join("\n\n")}\n`);
  return path;
}

function extractorConfig(capability, entryFile, reportFolder) {
  return ExtractorConfig.prepare({
    configObject: {
      projectFolder: AAI_ROOT,
      mainEntryPointFilePath: entryFile,
      apiReport: {
        enabled: true,
        reportFolder,
        reportFileName: `${capability}.api.md`,
        reportTempFolder: join(reportFolder, "temp"),
        // Same reasoning as `api-report.mjs`: a type a public signature
        // mentions is part of the contract even when it has no name to be
        // imported by, so changing one has to move the hash.
        includeForgottenExports: true,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            skipLibCheck: true,
            strict: true,
            target: "esnext",
            module: "preserve",
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
          },
        },
      },
      messages: {
        compilerMessageReporting: { default: { logLevel: "none" } },
        extractorMessageReporting: { default: { logLevel: "none" } },
        tsdocMessageReporting: { default: { logLevel: "none" } },
      },
    },
    configObjectFullPath: join(AAI_ROOT, "api-contracts.virtual.json"),
    packageJsonFullPath: join(AAI_ROOT, "package.json"),
  });
}

/**
 * Extract, hash and read back one report per capability.
 *
 * The hash covers the ROLLUP BODY, not the report file. API Extractor's
 * preamble ("Do not edit this file…") is identical in every report and is the
 * tool's, not ours — hashing it would make an api-extractor upgrade that
 * reworded one line bump all twelve epochs at once, each demanding a
 * classification for a change to nothing. eve hashes the whole file and pays
 * that; there is no reason to copy it.
 *
 * All capabilities share one `CompilerState`, so `dist` is parsed once rather
 * than twelve times.
 */
export function generateCapabilityReports(names = capabilities()) {
  mkdirSync(CACHE_ROOT, { recursive: true });
  const entryDir = join(CACHE_ROOT, "entrypoints");
  const reportDir = join(CACHE_ROOT, "reports");
  mkdirSync(entryDir, { recursive: true });
  mkdirSync(join(reportDir, "temp"), { recursive: true });
  try {
    const entries = names.map((capability) => parseEntrypoint(capability));
    const configs = entries.map((entry) => ({
      capability: entry.capability,
      config: extractorConfig(entry.capability, writeCapabilityEntry(entry, entryDir), reportDir),
    }));
    const compilerState = CompilerState.create(configs[0].config, {
      additionalEntryPoints: configs.slice(1).map((item) => item.config.mainEntryPointFilePath),
    });

    const reports = new Map();
    for (const { capability, config } of configs) {
      const messages = [];
      const result = Extractor.invoke(config, {
        compilerState,
        localBuild: true,
        showVerboseMessages: false,
        messageCallback(message) {
          if (message.logLevel === "error") messages.push(message.formatMessageWithoutLocation());
          message.handled = true;
        },
      });
      if (!result.succeeded) {
        throw new Error(
          messages[0] ?? `Could not extract the "${capability}" capability contract.`,
        );
      }
      const label = `the ${capability} capability report`;
      const text = readFileSync(join(reportDir, `${capability}.api.md`), "utf8");
      const body = stripPackageDocumentationMarker(reportSource(text, label));
      if (body === "") throw new Error(`The ${capability} capability rolled up to nothing.`);
      reports.set(capability, {
        body,
        exports: collectExports(text, label)
          .map((entry) => entry.name)
          .sort(),
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    }
    return reports;
  } finally {
    rmSync(CACHE_ROOT, { recursive: true, force: true });
  }
}

/** The published entry points a capability is allowed to draw from. */
export const AUTHORING_SUBPATHS = {
  ".": "index",
  "/utils": "utils",
  "/testing": "testing",
  "/tools": "tools",
  "/stt": "stt",
  "/llm": "llm",
  "/tts": "tts",
  "/s2s": "s2s",
};

/**
 * The authoring surface, read out of the committed per-entry-point reports.
 *
 * Reports rather than source, so this and the thing a reviewer looks at cannot
 * disagree. It does mean `check:api-report` has to pass first — a stale report
 * would be answered here as though it were current — which is why the gate
 * runs immediately after it in `check.sh` and says so if the reports are
 * missing entirely.
 *
 * A name tagged `@internal` ANYWHERE wins over a `@public` tag elsewhere: the
 * two barrels that re-export it are one decision, and the stricter reading is
 * the safe one for a list whose job is to be exhaustive.
 */
export function authoringSurface() {
  const publicNames = new Map();
  const internalNames = new Map();
  for (const [subpath, slug] of Object.entries(AUTHORING_SUBPATHS)) {
    const path = join(AAI_ROOT, "etc", `${slug}.api.md`);
    if (!existsSync(path)) {
      throw new Error(
        `${rel(path)} is missing. The capability contracts are read out of the committed ` +
          "API reports — run `pnpm api-report` first.",
      );
    }
    for (const entry of collectExports(readFileSync(path, "utf8"), rel(path))) {
      const target = entry.tag === "internal" ? internalNames : publicNames;
      if (!target.has(entry.name)) target.set(entry.name, new Set());
      target.get(entry.name).add(subpath);
    }
  }
  for (const name of internalNames.keys()) publicNames.delete(name);
  return { publicNames, internalNames };
}
