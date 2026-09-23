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
 *   are required (a `@sealed` one is probed like a value — below). Adding an
 *   optional member passes both; a required member, a widened or narrowed
 *   union, a changed member type, a removed member, or a stricter constraint
 *   fails one;
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
 * **Method members are compared as PROPERTIES.** TypeScript compares a
 * method-shorthand member (`send(x: string): void`) BIVARIANTLY even under
 * `strictFunctionTypes`, so a method parameter narrowed from `string | number`
 * to `string` passed both directions of the type probe and could ship as a
 * revision. Before anything is compiled, both rollups have every method
 * signature (interface, type literal, `declare class`, nested ones included)
 * rewritten to a property of function type: one signature as an arrow
 * (`send: (x: string) => void;`), an overload set as a call-signature literal
 * in declaration order (`on: { (e: "a"): void; (e: "b"): void };`, which
 * TypeScript relates exactly as it relates the overloaded method), `?` and
 * modifiers (`static`, `abstract`, `protected`) kept, type parameters and a
 * `this` parameter carried in. A literal opens a scope with no polymorphic
 * `this` TYPE, so an overload set returning `this` becomes an intersection of
 * arrows instead. A function type is not a method, so its parameters are
 * checked contravariantly. The rewrite is the same on both sides, so an
 * unchanged method still has identical closures. Two consequences:
 * - **One idiom stays a method**: a generic signature that intersects its own
 *   type parameter with a type applied to it (`label: L & Literal<L>`). Two
 *   such signatures cannot be related strictly even when identical —
 *   TypeScript infers one's `L` as the other's whole `L & Literal<L>` and then
 *   cannot prove the deferred conditional — so rewriting them made an
 *   unchanged `WorkflowContext.step` read as a break, and replaying the
 *   recorded revisions of `agent@13`, `dialog@7`, `step@3` and `tool@5` turned
 *   all four unprovable. Those groups keep method bivariance (a blind spot).
 * - A rollup class overriding a method of a base class from ANOTHER package
 *   now declares a property over a method (TS2425), which is reported — the
 *   safe direction, and no rollup does it today (every extended base is
 *   `Error`).
 *
 * **A class's constructor gets the same treatment.** Construct signatures from
 * a class declaration are also related bivariantly, so `typeof Old = New`
 * passes a narrowed constructor parameter; each class is additionally probed
 * with its constructor's parameters as a function type (`__Ctor`), checked
 * contravariantly.
 *
 * **A one-sided `any` is UNPROVEN, not compatible.** `any` is assignable both
 * ways, so a position that is `any` on one side and anything else on the other
 * passes every assignability check whatever changed there. Each probed pair is
 * walked in parallel (members, call and construct signatures' parameters and
 * returns, index signatures, a shared generic's type arguments) and every such
 * position is reported by path. The finding makes the result incompatible and
 * is also listed in `unproven`, so the gate says "not provably compatible"
 * rather than "the probe found a break": it may be harmless (a return loosened
 * to `any` breaks no caller), but the probe cannot say so, and saying nothing
 * was the old behaviour. An `any` on BOTH sides (`DefaultToolResult`, an
 * intentional escape hatch) is unchanged and not reported, and neither is an
 * unresolved name (the checker's error type, also `any` to it): its diagnostic
 * already fails the probe. The walk only reads a generic that neither rollup
 * declares (`Array`, `Record`, a sibling package's type) through its type
 * arguments — its members are those arguments substituted into one
 * declaration, and walking them reports the `any`s lib wrote.
 *
 * **Both rollups are rewritten to AGREE first** (`_api-contracts-compat-rewrite.mjs`):
 * a same-named `unique symbol` brand is one shared symbol, a long misuse
 * message literal is one marker type, and a `@sealed` type is probed
 * new-to-old only (`_api-contracts-compat-probes.mjs`) while every other probe
 * reads it through a MASKED new module in which it aliases the old one.
 *
 * **Which TypeScript.** The repo builds with `typescript@7`, which ships no
 * in-process compiler API: its root export is `lib/version.cjs`, and the
 * `typescript/unstable/sync` client it does ship drives the native `tsgo`
 * binary as a SUBPROCESS (verified: it can check a virtual program in ~0.4s).
 * That is ruled out twice here — the API is explicitly unstable, and a
 * subprocess would move `api-contracts-compat.test.ts` out of the unit tier,
 * which `aai-gates` does not have. So the CHECKER is `typescript-6` (the root's
 * alias of the `typedoc` catalog's `typescript@~6.0`, the same compiler `docs`
 * pins for TypeDoc): the last release with the JS compiler API, and the one
 * TypeScript shipped as the bridge to 7.0, whose type-checking semantics it is
 * meant to match. The PARSER stays
 * api-extractor's bundled TypeScript (5.9.3 at this writing): the rollups are
 * its output, and the node-walking helpers this shares with
 * `_api-contracts-hash.mjs` read that instance's `SyntaxKind`s. The two meet
 * only as TEXT — nothing crosses from one AST to the other. What the mismatch
 * leaves is a 7.x-only checker change (a bug fix, a new strictness) that 6.0
 * does not share; it would reach this gate one release late, and `pnpm
 * typecheck` on the frozen examples still runs 7.x over every retained epoch.
 *
 * Known blind spots, which is why `--bump --retain` still exists:
 * - `any` NESTED inside a union (`string | any` collapses to `any` and is
 *   caught; `Foo<any> | undefined` is walked only through its non-nullable
 *   half) and positions the walk does not pair (union members, overloads
 *   whose counts differ) can still hide an `any`;
 * - a generic method in the `L & Literal<L>` idiom above is still compared
 *   bivariantly, and a class's constructor OVERLOADS are probed through the
 *   last one only (`infer` reads the last signature);
 * - generic overloads are related with their type parameters erased, as
 *   TypeScript relates any two overload sets, so a change expressed only
 *   through an overload's type parameter can pass;
 * - a type from ANOTHER package is the same current type on both sides, so a
 *   break there is that package's capability to report, not this one's;
 * - behaviour (a default's value, what a function does) is never checked;
 * - a deferred conditional type compared under generic parameters may be
 *   reported incompatible when it is not — the safe direction.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { oneSidedAny, probedPairs } from "./_api-contracts-compat-any.mjs";
import { methodsAsProperties } from "./_api-contracts-compat-methods.mjs";
import { agreements, CTOR, probeFor, WIDEN } from "./_api-contracts-compat-probes.mjs";
import {
  rewriteForProbe,
  SHARED_MODULE,
  sealedAlias,
  sharedModule,
} from "./_api-contracts-compat-rewrite.mjs";
import { referencedNames } from "./_api-contracts-hash.mjs";
import { compareNames, declarationNames } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
/** The PARSER: the TypeScript that wrote the rollups (see the header). */
const ts = extractorRequire("typescript");
/** The CHECKER: the 6.x line, the last with a JS compiler API (see the header). */
const checkerTs = require("typescript-6");

const OPTIONS = {
  strict: true,
  exactOptionalPropertyTypes: true,
  target: checkerTs.ScriptTarget.ESNext,
  module: checkerTs.ModuleKind.Preserve,
  moduleResolution: checkerTs.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  // TypeScript 6 stopped auto-including every visible `@types` package (its
  // default `types` is `[]`), and the rollups name `NodeJS.*` — which the 5.9
  // checker this replaced found only because `@types/node` was visible.
  types: ["node"],
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

/** A removed export, or a re-export whose source moved; `undefined` when neither. */
function exportProblem(entry, next) {
  if (next === undefined) return `${entry.name}: removed from the capability`;
  if (entry.reExport === undefined && next.reExport === undefined) return;
  if (next.reExport === entry.reExport) return;
  return `${entry.name}: now ${next.reExport ?? "declared here"}, was ${entry.reExport ?? "declared here"}`;
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
  const agreed = agreements(before, after);
  const problems = [];
  const probes = [];
  const changed = (name) => oldClosure(name) !== newClosure(name);
  for (const entry of oldExports.values()) {
    const next = newExports.get(entry.name);
    const problem = exportProblem(entry, next);
    if (problem !== undefined) problems.push(problem);
    else if (entry.reExport === undefined && changed(entry.name)) {
      const sealed = agreed.sealed.has(entry.name) && (entry.type || entry.klass);
      const options = sealed ? { sealed, target: `__N.${sealedAlias(entry.name)}` } : {};
      probes.push({ name: entry.name, text: probeFor(entry, probes.length, options) });
    }
  }
  // A masked UNEXPORTED sealed type is otherwise probed nowhere: every export
  // reaching it now sees the old declaration.
  for (const name of agreed.masked) {
    if (oldExports.has(name) || !changed(name)) continue;
    const entry = kindOf(name, before.declared.get(name), before.sourceFile);
    const options = { sealed: true, target: `__N.${sealedAlias(name)}` };
    probes.push({ name, text: probeFor(entry, probes.length, options) });
  }
  const added = [...newExports.keys()].filter((name) => !oldExports.has(name)).sort(compareNames);
  return { problems, probes, added, agreed };
}

/** A compiler host over two virtual modules, reading everything else from disk (cached). */
function virtualHost(virtual, probeDir) {
  const host = checkerTs.createCompilerHost(OPTIONS, true);
  const readReal = host.readFile.bind(host);
  const realDirectoryExists = host.directoryExists?.bind(host) ?? existsSync;
  host.fileExists = (path) => virtual.has(path) || existsSync(path);
  host.readFile = (path) => virtual.get(path) ?? readReal(path);
  host.directoryExists = (path) => path === probeDir || realDirectoryExists(path);
  host.getSourceFile = (path, languageVersion) => {
    const text = virtual.get(path);
    if (text !== undefined) return checkerTs.createSourceFile(path, text, languageVersion, true);
    const key = `${path}\0${JSON.stringify(languageVersion)}`;
    if (!parsed.has(key) && existsSync(path)) {
      parsed.set(
        key,
        checkerTs.createSourceFile(path, readFileSync(path, "utf8"), languageVersion),
      );
    }
    return parsed.get(key);
  };
  return host;
}

/** One diagnostic, shortened, with the probe modules' absolute paths taken out. */
function describeDiagnostic(diagnostic, probeDir) {
  return checkerTs
    .flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    .split("\n")
    .slice(0, 3)
    .join(" / ")
    .replaceAll(`import("${probeDir}/old")`, "old")
    .replaceAll(`import("${probeDir}/new")`, "new")
    .replaceAll(`import("${probeDir}/masked")`, "new");
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
 * `unproven` is the subset of `problems` that is not a failed check but a
 * position the probe cannot decide (a one-sided `any`); a result whose every
 * problem is one of those is "not provably compatible" rather than a break.
 *
 * @returns {{ compatible: boolean, problems: string[], unproven: string[], added: string[] }}
 */
export function probeCompatibility({ oldBody, newBody, dir }) {
  const before = methodsAsProperties(oldBody);
  const after = methodsAsProperties(newBody);
  const { problems, probes, added, agreed } = planProbes(before, after);
  const probeDir = join(dir, ".api-contracts-probe");
  const oldPath = join(probeDir, "old.ts");
  const newPath = join(probeDir, "new.ts");
  const maskedPath = join(probeDir, "masked.ts");
  const { brands, sealed, masked } = agreed;
  const exportSealed = [...sealed];
  const maskedModule = masked.length > 0 ? "./masked.ts" : "./new.ts";
  const spans = [];
  let oldText =
    `${asModule(rewriteForProbe(before, { brands, exportSealed: masked }))}\n\n` +
    `import * as __N from "./new.ts";\nimport * as __M from "${maskedModule}";\n${WIDEN}\n${CTOR}\n`;
  for (const probe of probes) {
    const start = oldText.length;
    oldText += `${probe.text}\n`;
    spans.push({ name: probe.name, start, end: oldText.length });
  }
  const virtual = new Map([
    [oldPath, oldText],
    [newPath, asModule(rewriteForProbe(after, { brands, exportSealed }))],
    [join(probeDir, SHARED_MODULE), sharedModule(brands)],
  ]);
  if (masked.length > 0) {
    virtual.set(maskedPath, asModule(rewriteForProbe(after, { brands, mask: masked })));
  }
  const program = checkerTs.createProgram({
    rootNames: [oldPath, newPath],
    options: OPTIONS,
    host: virtualHost(virtual, probeDir),
  });
  // Identical sides (the gate's self-probe of every pinned rollup) would only
  // repeat the old module's diagnostics, at the cost of checking it twice.
  for (const path of oldBody === newBody ? [oldPath] : [oldPath, newPath]) {
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
  const checker = program.getTypeChecker();
  const unproven = [];
  for (const pair of probedPairs(checker, program.getSourceFile(oldPath), probes)) {
    for (const position of oneSidedAny(checker, pair.before, pair.after)) {
      unproven.push(
        `${pair.name}: ${position} — \`any\` is assignable both ways, so nothing about that position is proven`,
      );
    }
  }
  const unique = [...new Set([...problems, ...unproven])];
  return {
    compatible: unique.length === 0,
    problems: unique,
    unproven: [...new Set(unproven)],
    added,
  };
}
