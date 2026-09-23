#!/usr/bin/env node

/**
 * Is a capability's new rollup BACKWARD COMPATIBLE with the one its epoch was
 * minted from? The proof behind a revision (see `_api-contracts-mint.mjs`).
 *
 * The epoch's rollup is committed beside it (`v<N>.rollup.txt`, the report
 * body API Extractor produced when the epoch was minted). To decide a change,
 * this compiles ONE program: the old rollup as a module, the new rollup as a
 * second module, and a probe appended to the old one — in the old module's own
 * scope, so its type parameters, constraints and unexported helpers are in
 * reach — that asserts, per name the old epoch exported:
 *
 * - **still exported** (a removed export is a break, reported by name);
 * - **a type** (interface, alias, class instance): MUTUALLY assignable, old to
 *   new and new to old, under the old declaration's own type parameters. An
 *   author both BUILDS these (config objects, test fakes) and RECEIVES them
 *   (`ctx`, results), and the rollup does not say which, so both directions
 *   are required. Adding an optional member passes both; a required member, a
 *   widened or narrowed union, a changed member type, a removed member, or a
 *   stricter constraint fails one;
 * - **a value** (function, const, class constructor): NEW assignable to OLD —
 *   everything a caller wrote against the old signature still type-checks.
 *   A widened parameter or a narrowed return passes; an added required
 *   parameter, a narrowed parameter, or a return that provides less fails. A
 *   const's literal values are widened to their primitive first, matching the
 *   hash (a changed default is behaviour, not shape).
 *
 * Compiled with `strict` and `exactOptionalPropertyTypes` — the stricter of
 * the settings a consumer might use, so a change that breaks only under the
 * stricter one still counts. Imports from other packages resolve to their
 * CURRENT `dist`, on both sides.
 *
 * Known blind spots, which is why `--bump --retain` still exists:
 * - method-shorthand members are compared BIVARIANTLY by TypeScript, so a
 *   method parameter moving to a sub- or super-type is invisible (a
 *   property-style function member is checked strictly);
 * - `any` is assignable both ways, so a type that is or contains `any`
 *   proves nothing about that position;
 * - a type from ANOTHER package is the same current type on both sides, so a
 *   break there is that package's capability to report, not this one's;
 * - behaviour (a default's value, what a function does) is never checked;
 * - a deferred conditional type compared under generic parameters may be
 *   reported incompatible when it is not — the safe direction.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { referencedNames } from "./_api-contracts-hash.mjs";
import { compareNames, declarationNames } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

const OPTIONS = {
  strict: true,
  exactOptionalPropertyTypes: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
  allowImportingTsExtensions: true,
};

/** Real files parsed once per process — lib and `dist` declarations dominate the cost. */
const parsed = new Map();

const kindsNeedingDeclare = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.EnumDeclaration,
]);

const modifiersOf = (statement) => ts.getModifiers?.(statement) ?? [];
const has = (statement, kind) => modifiersOf(statement).some((m) => m.kind === kind);

/**
 * A report body as a `.ts` module: API Extractor writes `const X: T;` and
 * bodiless `function f(): T;`, which only a declaration file admits, so each
 * gets the `declare` it implies.
 */
function asModule(body) {
  const sourceFile = ts.createSourceFile("x.ts", body, ts.ScriptTarget.Latest, true);
  const inserts = [];
  for (const statement of sourceFile.statements) {
    if (!kindsNeedingDeclare.has(statement.kind) || has(statement, ts.SyntaxKind.DeclareKeyword)) {
      continue;
    }
    const exported = modifiersOf(statement).find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    inserts.push(exported === undefined ? statement.getStart(sourceFile) : exported.getEnd() + 1);
  }
  let out = body;
  for (const at of inserts.sort((a, b) => b - a)) {
    out = `${out.slice(0, at)}declare ${out.slice(at)}`;
  }
  return out;
}

/** One body's top-level names: imports, declarations, and what it exports. */
function parseBody(body) {
  const sourceFile = ts.createSourceFile("x.ts", body, ts.ScriptTarget.Latest, true);
  const parsedBody = {
    sourceFile,
    imports: new Map(),
    declared: new Map(),
    exported: new Set(),
    reExported: new Map(),
  };
  for (const statement of sourceFile.statements) addStatement(parsedBody, statement);
  return parsedBody;
}

const originalName = (element) => (element.propertyName ?? element.name).text;

function addStatement({ imports, declared, exported, reExported }, statement) {
  if (ts.isImportDeclaration(statement)) {
    const module = statement.moduleSpecifier.text;
    for (const e of namedImports(statement))
      imports.set(e.name.text, `${module}#${originalName(e)}`);
    return;
  }
  if (ts.isExportDeclaration(statement)) {
    for (const e of statement.exportClause?.elements ?? [])
      reExported.set(e.name.text, originalName(e));
    return;
  }
  const isExported = has(statement, ts.SyntaxKind.ExportKeyword);
  for (const name of declarationNames(statement)) {
    if (!declared.has(name)) declared.set(name, []);
    declared.get(name).push(statement);
    if (isExported) exported.add(name);
  }
}

function namedImports(statement) {
  const bindings = statement.importClause?.namedBindings;
  return bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements : [];
}

/** What kind of thing one declared name is, read off all its statements. */
function kindOf(name, statements, sourceFile) {
  const entry = { name, type: false, value: false, klass: false, isConst: false, sourceFile };
  for (const statement of statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      entry.type = true;
    } else if (ts.isClassDeclaration(statement)) {
      entry.klass = true;
    } else {
      entry.value = true;
      entry.isConst ||=
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    }
    entry.typeParameters ??= statement.typeParameters;
  }
  return entry;
}

/**
 * Every name a body exports: `{ reExport }` for a name re-exported from
 * another module (identical on both sides by construction), else its kind.
 */
function exportsOf(parsedBody) {
  const { sourceFile, imports, declared, exported, reExported } = parsedBody;
  const found = new Map();
  for (const name of exported) found.set(name, kindOf(name, declared.get(name), sourceFile));
  for (const [name, local] of reExported) {
    found.set(
      name,
      imports.has(local)
        ? { name, reExport: imports.get(local) }
        : kindOf(name, declared.get(local) ?? [], sourceFile),
    );
  }
  return found;
}

/**
 * For each top-level name, the text of its declaration and of everything it
 * reaches inside the same body — plus the module each imported name it
 * reaches comes from.
 *
 * Two equal closures ARE the same type, which the probe cannot always say: a
 * conditional or `as`-remapped mapped type declared twice is two unrelated
 * declarations to the checker, so an UNCHANGED generic one would otherwise read
 * as a break forever.
 */
function closureOf(parsedBody) {
  const { sourceFile, imports, declared } = parsedBody;
  const known = (name) => declared.has(name) || imports.has(name);
  return (root) => {
    const seen = new Set([root]);
    const queue = [root];
    const parts = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (imports.has(current)) parts.push(`${current} <- ${imports.get(current)}`);
      for (const statement of declared.get(current) ?? []) {
        parts.push(statement.getText(sourceFile));
        const next = [...referencedNames(statement)].filter((ref) => !seen.has(ref) && known(ref));
        for (const ref of next) seen.add(ref);
        queue.push(...next);
      }
    }
    return parts.sort(compareNames).join("\n");
  };
}

const WIDEN =
  "type __Widen<T> = T extends string ? string : T extends number ? number : " +
  "T extends boolean ? boolean : T extends bigint ? bigint : " +
  "T extends (...args: never) => unknown ? T : T extends object ? { [K in keyof T]: __Widen<T[K]> } : T;";

/** The probe for one exported name, as source text in the OLD module's scope. */
function probeFor(entry, index) {
  const lines = [];
  const params = entry.typeParameters;
  const list =
    params === undefined ? "" : `<${params.map((p) => p.getText(entry.sourceFile)).join(", ")}>`;
  const args = params === undefined ? "" : `<${params.map((p) => p.name.text).join(", ")}>`;
  const { name } = entry;
  if (entry.type || entry.klass) {
    lines.push(
      `export function __type${index}${list}(o: ${name}${args}, n: __N.${name}${args}): void {`,
      `  const a: __N.${name}${args} = o; const b: ${name}${args} = n; void a; void b;`,
      "}",
    );
  }
  if (entry.value || entry.klass) {
    const target = entry.isConst ? `__Widen<typeof ${name}>` : `typeof ${name}`;
    lines.push(`export const __value${index}: ${target} = __N.${name};`);
  }
  return lines.join("\n");
}

/**
 * The export-level findings and the probes still to compile: a removed name,
 * a re-export whose source moved, and one probe per name whose closure is not
 * byte-identical on both sides.
 */
function planProbes(oldBody, newBody) {
  const before = parseBody(oldBody);
  const after = parseBody(newBody);
  const oldExports = exportsOf(before);
  const newExports = exportsOf(after);
  const oldClosure = closureOf(before);
  const newClosure = closureOf(after);
  const problems = [];
  const probes = [];
  for (const entry of oldExports.values()) {
    const next = newExports.get(entry.name);
    if (next === undefined) {
      problems.push(`${entry.name}: removed from the capability`);
    } else if (entry.reExport !== undefined || next.reExport !== undefined) {
      if (next.reExport !== entry.reExport) {
        problems.push(
          `${entry.name}: now ${next.reExport ?? "declared here"}, was ${entry.reExport ?? "declared here"}`,
        );
      }
    } else if (oldClosure(entry.name) !== newClosure(entry.name)) {
      probes.push({ name: entry.name, text: probeFor(entry, probes.length) });
    }
  }
  const added = [...newExports.keys()].filter((name) => !oldExports.has(name)).sort(compareNames);
  return { problems, probes, added };
}

/** A compiler host over two virtual modules, reading everything else from disk (cached). */
function virtualHost(virtual, probeDir) {
  const host = ts.createCompilerHost(OPTIONS, true);
  const readReal = host.readFile.bind(host);
  const realDirectoryExists = host.directoryExists?.bind(host) ?? existsSync;
  host.fileExists = (path) => virtual.has(path) || existsSync(path);
  host.readFile = (path) => virtual.get(path) ?? readReal(path);
  host.directoryExists = (path) => path === probeDir || realDirectoryExists(path);
  host.getSourceFile = (path, languageVersion) => {
    const text = virtual.get(path);
    if (text !== undefined) return ts.createSourceFile(path, text, languageVersion, true);
    const key = `${path}\0${languageVersion}`;
    if (!parsed.has(key) && existsSync(path)) {
      parsed.set(key, ts.createSourceFile(path, readFileSync(path, "utf8"), languageVersion));
    }
    return parsed.get(key);
  };
  return host;
}

/** One diagnostic, shortened, with the probe modules' absolute paths taken out. */
function describeDiagnostic(diagnostic, probeDir) {
  return ts
    .flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    .split("\n")
    .slice(0, 3)
    .join(" / ")
    .replaceAll(`import("${probeDir}/old")`, "old")
    .replaceAll(`import("${probeDir}/new")`, "new");
}

/** Which probe (or which side's rollup) a diagnostic belongs to. */
function locate(diagnostic, isOld, spans) {
  if (!isOld) return "the new rollup";
  const at = diagnostic.start ?? 0;
  return spans.find((s) => at >= s.start && at < s.end)?.name ?? "the epoch's committed rollup";
}

/**
 * Decide whether `newBody` is backward compatible with `oldBody`.
 *
 * `dir` is where the two virtual modules pretend to live, so their own
 * imports (`zod`, `react`, a sibling package) resolve from that package.
 *
 * @returns {{ compatible: boolean, problems: string[], added: string[] }}
 */
export function probeCompatibility({ oldBody, newBody, dir }) {
  const { problems, probes, added } = planProbes(oldBody, newBody);
  const probeDir = join(dir, ".api-contracts-probe");
  const oldPath = join(probeDir, "old.ts");
  const newPath = join(probeDir, "new.ts");
  const spans = [];
  let oldText = `${asModule(oldBody)}\n\nimport * as __N from "./new.ts";\n${WIDEN}\n`;
  for (const probe of probes) {
    const start = oldText.length;
    oldText += `${probe.text}\n`;
    spans.push({ name: probe.name, start, end: oldText.length });
  }
  const virtual = new Map([
    [oldPath, oldText],
    [newPath, asModule(newBody)],
  ]);
  const program = ts.createProgram({
    rootNames: [oldPath, newPath],
    options: OPTIONS,
    host: virtualHost(virtual, probeDir),
  });
  for (const path of [oldPath, newPath]) {
    const file = program.getSourceFile(path);
    const diagnostics = [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ];
    for (const diagnostic of diagnostics) {
      problems.push(
        `${locate(diagnostic, path === oldPath, spans)}: ${describeDiagnostic(diagnostic, probeDir)}`,
      );
    }
  }
  const unique = [...new Set(problems)];
  return { compatible: unique.length === 0, problems: unique, added };
}
