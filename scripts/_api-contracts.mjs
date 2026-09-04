#!/usr/bin/env node

/**
 * Turning a capability into a REPORT: how its synthetic entry point is made
 * into something API Extractor can analyse, and how a package's authoring
 * surface is read back out of the committed reports.
 *
 * `_api-contracts-tree.mjs` below it owns where the files live and which
 * packages carry them; `_api-contracts-checks.mjs` above it owns what a finding
 * is. This file is the only one that knows about api-extractor.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

import {
  authoringSubpaths,
  capabilities,
  capabilityId,
  readManifest,
  rel,
} from "./_api-contracts-tree.mjs";
import { collectExports, reportSource, stripPackageDocumentationMarker } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const { CompilerState, Extractor, ExtractorConfig, ExtractorLogLevel } =
  require("@microsoft/api-extractor");

/**
 * The published entry point each source module is reachable through.
 *
 * A capability may only draw from a PUBLISHED subpath, and this is what
 * enforces it: the map is keyed by the `@dev/source` path in the package's
 * `exports`, so an entry point re-exporting from some internal module resolves
 * to nothing and the extraction fails by name. It also means the contract is
 * extracted from `dist` — the same declarations a consumer installs — while the
 * authored file points at source and therefore type-checks in the ordinary
 * `pnpm typecheck` run.
 */
function publishedSubpaths(pkg) {
  const manifest = readManifest(join(pkg.dir, "package.json"));
  const bySource = new Map();
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target !== "object" || target === null) continue;
    const source = target["@dev/source"];
    const runtime = target.import;
    if (typeof source !== "string" || typeof runtime !== "string") continue;
    bySource.set(resolve(pkg.dir, source), { subpath, runtime: resolve(pkg.dir, runtime) });
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
export function parseEntrypoint(pkg, capability) {
  const path = join(pkg.entrypointRoot, `${capability}.ts`);
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
  return { pkg, capability, path, groups, names };
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
  const bySource = publishedSubpaths(entry.pkg);
  const path = join(outputDir, `${entry.capability}.d.ts`);
  const blocks = entry.groups.map((group) => {
    const published = bySource.get(group.source);
    if (published === undefined) {
      throw new Error(
        `${rel(entry.path)}: "${group.specifier}" is not a published entry point of ` +
          `${entry.pkg.name}. A capability may only draw from a subpath in that package's ` +
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

function extractorConfig(pkg, capability, entryFile, reportFolder) {
  return ExtractorConfig.prepare({
    configObject: {
      projectFolder: pkg.dir,
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
        compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
        extractorMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
        tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
      },
    },
    configObjectFullPath: join(pkg.dir, "api-contracts.virtual.json"),
    packageJsonFullPath: join(pkg.dir, "package.json"),
  });
}

/**
 * Extract, hash and read back one report per capability of one package.
 *
 * The hash covers the ROLLUP BODY, not the report file. API Extractor's
 * preamble ("Do not edit this file…") is identical in every report and is the
 * tool's, not ours — hashing it would make an api-extractor upgrade that
 * reworded one line bump every epoch at once, each demanding a classification
 * for a change to nothing. eve hashes the whole file and pays that; there is no
 * reason to copy it.
 *
 * All of a package's capabilities share one `CompilerState`, so its `dist` is
 * parsed once rather than once per capability.
 */
export function generateCapabilityReports(pkg, names = capabilities(pkg)) {
  mkdirSync(pkg.cacheRoot, { recursive: true });
  const entryDir = join(pkg.cacheRoot, "entrypoints");
  const reportDir = join(pkg.cacheRoot, "reports");
  mkdirSync(entryDir, { recursive: true });
  mkdirSync(join(reportDir, "temp"), { recursive: true });
  try {
    const entries = names.map((capability) => parseEntrypoint(pkg, capability));
    const configs = entries.map((entry) => ({
      capability: entry.capability,
      config: extractorConfig(
        pkg,
        entry.capability,
        writeCapabilityEntry(entry, entryDir),
        reportDir,
      ),
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
          messages[0] ??
            `Could not extract the "${capabilityId(pkg, capability)}" capability contract.`,
        );
      }
      const label = `the ${capabilityId(pkg, capability)} capability report`;
      const text = readFileSync(join(reportDir, `${capability}.api.md`), "utf8");
      const body = stripPackageDocumentationMarker(reportSource(text, label));
      if (body === "") {
        throw new Error(`The ${capabilityId(pkg, capability)} capability rolled up to nothing.`);
      }
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
    rmSync(pkg.cacheRoot, { recursive: true, force: true });
  }
}

/**
 * One package's authoring surface, read out of its committed per-entry-point
 * reports.
 *
 * Reports rather than source, so this and the thing a reviewer looks at cannot
 * disagree. It does mean `check:api-report` has to pass first — a stale report
 * would be answered here as though it were current — which is why the gate
 * runs immediately after it in `check.mjs` and says so if the reports are
 * missing entirely.
 *
 * A name tagged `@internal` ANYWHERE wins over a `@public` tag elsewhere: two
 * barrels re-exporting one name is one decision, and the stricter reading is
 * the safe one for a list whose job is to be exhaustive.
 */
export function authoringSurface(pkg) {
  const publicNames = new Map();
  const internalNames = new Map();
  for (const [subpath, slug] of Object.entries(authoringSubpaths(pkg))) {
    const path = join(pkg.dir, "etc", `${slug}.api.md`);
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
