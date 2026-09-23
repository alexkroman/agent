#!/usr/bin/env node

/**
 * The probe TEXT `_api-contracts-compat.mjs` appends to the old module — one
 * function or const per compared name — and the agreements that decide its
 * shape: which brands the two sides share, and which names are `@sealed`. The
 * argument for each is in that module's header and in
 * `_api-contracts-compat-rewrite.mjs`.
 */

import { createRequire } from "node:module";
import { isSealedStatement, uniqueSymbolNames } from "./_api-contracts-compat-rewrite.mjs";
import { compareNames } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

export const WIDEN =
  "type __Widen<T> = T extends string ? string : T extends number ? number : " +
  "T extends boolean ? boolean : T extends bigint ? bigint : " +
  "T extends (...args: never) => unknown ? T : T extends object ? { [K in keyof T]: __Widen<T[K]> } : T;";

/**
 * A class's constructor parameters as a FUNCTION type. TypeScript relates the
 * construct signatures of a class declaration bivariantly, like methods, so
 * `typeof Old = New` passes a narrowed constructor parameter; a function type
 * built from the same parameters is checked contravariantly. `infer` reads the
 * LAST overload only (see the header's blind spots).
 */
export const CTOR =
  "type __Ctor<C> = C extends abstract new (...args: infer A) => unknown ? (...args: A) => void : never;";

/**
 * The probe for one name, as source text in the OLD module's scope.
 *
 * `__M` is the new rollup with every `@sealed` type masked to its old
 * declaration (see `_api-contracts-compat-rewrite.mjs`); `__N` is the real one.
 * A sealed type's own probe is therefore the only place its change is seen,
 * and it is new-to-old only — an author RECEIVES a sealed type and never
 * builds one, so the probe is the value's: everything the old one offered is
 * still there. `target` names how the new side reaches it (`__N.Foo`, or
 * `__N.__sealed_Foo` for an unexported one).
 */
export function probeFor(entry, index, { sealed = false, target = `__M.${entry.name}` } = {}) {
  const lines = [];
  const params = entry.typeParameters;
  const list =
    params === undefined ? "" : `<${params.map((p) => p.getText(entry.sourceFile)).join(", ")}>`;
  const args = params === undefined ? "" : `<${params.map((p) => p.name.text).join(", ")}>`;
  const { name } = entry;
  if (sealed) {
    lines.push(
      `export function __type${index}${list}(o: ${name}${args}, n: ${target}${args}): void {`,
      `  const b: ${name}${args} = n; void o; void b;`,
      "}",
    );
  } else if (entry.type || entry.klass) {
    lines.push(
      `export function __type${index}${list}(o: ${name}${args}, n: __M.${name}${args}): void {`,
      `  const a: __M.${name}${args} = o; const b: ${name}${args} = n; void a; void b;`,
      "}",
    );
  }
  if (entry.value || entry.klass) {
    const target = entry.isConst ? `__Widen<typeof ${name}>` : `typeof ${name}`;
    lines.push(`export const __value${index}: ${target} = __M.${name};`);
  }
  if (entry.klass) {
    lines.push(
      `export function __ctor${index}(n: __Ctor<typeof __M.${name}>): void {`,
      `  const o: __Ctor<typeof ${name}> = n; void o;`,
      "}",
    );
  }
  return lines.join("\n");
}

/** Names some statement in a body tags `@sealed`. */
function sealedIn({ sourceFile, declared }) {
  const found = new Set();
  for (const [name, statements] of declared) {
    if (statements.some((statement) => isSealedStatement(statement, sourceFile))) found.add(name);
  }
  return found;
}

/** Names a body declares `const X: unique symbol`. */
const brandsIn = ({ sourceFile }) => new Set(sourceFile.statements.flatMap(uniqueSymbolNames));

const isPureType = (statements) =>
  statements.length > 0 &&
  statements.every((s) => ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s));

/**
 * What the two sides must agree on before anything is compiled: the
 * declarations ANOTHER capability of the package owns (`shared`: taken from
 * the new rollup on both sides — see `_api-contracts-compat-rewrite.mjs`), the brands
 * they share (one `unique symbol` per name), the `@sealed` names (tagged on
 * EITHER side — adding the tag is the claim, and it shows in the API report's
 * diff), and which of those can be masked: a pure type on both sides with the
 * same number of type parameters.
 */
export function agreements(before, after, foreign = new Set()) {
  const newBrands = brandsIn(after);
  const brands = new Set([...brandsIn(before)].filter((name) => newBrands.has(name)));
  const inBoth = (name) => before.declared.has(name) && after.declared.has(name);
  const exported = (name) => before.exported.has(name) || after.exported.has(name);
  const shared = [...foreign]
    .filter((name) => inBoth(name) && !exported(name) && !brands.has(name))
    .sort(compareNames);
  const isShared = new Set(shared);
  const sealed = new Set(
    [...sealedIn(before), ...sealedIn(after)].filter((name) => inBoth(name) && !isShared.has(name)),
  );
  const arity = (statements) => statements[0]?.typeParameters?.length ?? 0;
  const masked = [...sealed].filter((name) => {
    const o = before.declared.get(name);
    const n = after.declared.get(name);
    return isPureType(o) && isPureType(n) && arity(o) === arity(n);
  });
  return { brands, sealed, masked, shared };
}
