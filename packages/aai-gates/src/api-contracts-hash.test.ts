// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The epoch hash ignores what cannot break a consumer, and NOTHING ELSE.
 *
 * `scripts/_api-contracts-hash.mjs` decides which textual differences in a
 * capability's rollup have to be CLASSIFIED. Every line it normalizes away is a
 * bump somebody no longer has to write a paragraph about — and also, if it is
 * wrong, a breaking change that lands with a green gate. So this suite is
 * written in pairs: for each normalization, one case proving the noise is gone
 * and one proving the neighbouring real change still moves the hash.
 *
 * The failure shape it exists for is the one every gate guard here exists for.
 * A `hashableBody` that returned `""`, or that elided every declaration, would
 * agree with itself forever: `pnpm check:api-contracts` would print
 * "53 capability contract(s) up to date ✓" over a surface that had been
 * rewritten. The "still moves" half of each pair is what an over-eager
 * normalization fails.
 *
 * It asserts on the normalized TEXT rather than a digest, because a hash
 * comparison that fails says only "different" — and the whole subject here is
 * WHICH difference.
 */

import { describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

/**
 * The normalizer, imported as a real value.
 *
 * `hashableBody` is pure (text and a name set in, text out), so exercising it
 * directly is a behavioural test rather than the self-assertion the sibling
 * gate specs avoid by reading their subject as `?raw`. Same namespace-glob
 * shape as `guard-invariants-scanner-rules.test.ts`, and destructured with a
 * fallback so "is importable" stays an assertion rather than a crash.
 */
const { hashableBody } =
  sole(
    import.meta.glob<{
      hashableBody: (body: string, foreign: Set<string>) => string;
    }>("../../../scripts/_api-contracts-hash.mjs", { eager: true }),
  ) ?? {};

const NONE = new Set<string>();
/** What the normalizer does to a body, or a marker naming why it did nothing. */
const normalized = (body: string, foreign: Set<string> = NONE) =>
  hashableBody?.(body, foreign) ?? "hashableBody-not-importable";

describe("the normalizer is importable", () => {
  test("hashableBody is exported", () => {
    expect(hashableBody, "hashableBody not exported").toBeTypeOf("function");
  });

  test("it does not collapse a body to nothing", () => {
    // The whole gate compares two derivations; one that hashed "" would agree
    // with a committed "" and check nothing ever again.
    expect(
      normalized("// @public\nexport declare function tool(options: Options): ToolDef;"),
    ).not.toBe("");
  });
});

describe("parameter names — the `opts` to `options` class", () => {
  // The historical case: one PR renamed this parameter across the SDK and
  // forced 36 capability classifications, each recorded as "compiles
  // unchanged".
  const before = "// @public\nexport declare function tool(opts: ToolOptions): ToolDef;";
  const after = "// @public\nexport declare function tool(options: ToolOptions): ToolDef;";

  test("renaming a parameter does not move the hash", () => {
    expect(normalized(after)).toBe(normalized(before));
  });

  test("renaming a parameter of a method signature does not move it either", () => {
    const a = "// @public\nexport interface WorkflowClient {\n    get(of: string): Run;\n}";
    const b = "// @public\nexport interface WorkflowClient {\n    get(workflow: string): Run;\n}";
    expect(normalized(b)).toBe(normalized(a));
  });

  test("a type predicate naming the renamed parameter moves with it", () => {
    // Otherwise the rename escapes through `value is ToolFailure` and the
    // normalization silently only half-works.
    const a = "// @public\nexport declare function isToolFailure(v: unknown): v is ToolFailure;";
    const b =
      "// @public\nexport declare function isToolFailure(value: unknown): value is ToolFailure;";
    expect(normalized(b)).toBe(normalized(a));
  });

  test("but a parameter's TYPE still moves the hash", () => {
    const widened = "// @public\nexport declare function tool(options: unknown): ToolDef;";
    expect(normalized(widened)).not.toBe(normalized(after));
  });

  test("and so does adding one", () => {
    const extra =
      "// @public\nexport declare function tool(options: ToolOptions, extra: number): ToolDef;";
    expect(normalized(extra)).not.toBe(normalized(after));
  });

  test("and so does making one optional", () => {
    const optional = "// @public\nexport declare function tool(options?: ToolOptions): ToolDef;";
    expect(normalized(optional)).not.toBe(normalized(after));
  });

  test("a `this` parameter keeps its name", () => {
    // It is a keyword in that position, not something a caller passes.
    expect(
      normalized("// @public\nexport declare function f(this: Ctx, a: number): void;"),
    ).toContain("this: Ctx");
  });
});

describe("declarations another capability contracts", () => {
  // `aai:tool`'s report inlines `WorkflowCtx` because `ToolContext.workflows`
  // reaches it, so every workflow reshape used to bump `tool` too — 74% of that
  // capability's hashed lines were somebody else's.
  const withCtx = (members: string) =>
    "// @public\nexport interface ToolContext {\n    workflows: WorkflowClient;\n}\n\n" +
    `// @public\ninterface WorkflowCtx {\n${members}\n}`;
  const foreign = new Set(["WorkflowCtx"]);

  test("reshaping a foreign declaration does not move the hash", () => {
    const a = normalized(withCtx("    step(name: string): void;"), foreign);
    const b = normalized(withCtx("    step(name: string): void;\n    now(): number;"), foreign);
    expect(b).toBe(a);
  });

  test("its release tag and doc state go with it", () => {
    const undocumented = withCtx("    step(name: string): void;").replace(
      "// @public\ninterface WorkflowCtx",
      "// @public (undocumented)\ninterface WorkflowCtx",
    );
    expect(normalized(undocumented, foreign)).toBe(
      normalized(withCtx("    step(name: string): void;"), foreign),
    );
  });

  test("the name is still there, so REACHING it is still contracted", () => {
    expect(normalized(withCtx("    step(name: string): void;"), foreign)).toContain("WorkflowCtx");
  });

  test("losing a foreign declaration DOES move the hash", () => {
    // A capability that stops reaching a type has had its surface change, and
    // that is exactly what an epoch records.
    const reaching = normalized(withCtx("    step(name: string): void;"), foreign);
    const gone = normalized(
      "// @public\nexport interface ToolContext {\n    x: number;\n}",
      foreign,
    );
    expect(gone).not.toBe(reaching);
  });

  test("a capability's OWN declaration is never elided", () => {
    // `foreign` is built as "owned by a sibling MINUS owned by me", so this
    // guards the subtraction: eliding a capability's own surface would be the
    // gate checking nothing about the thing it is named for.
    const a = normalized("// @public\nexport interface WorkflowCtx {\n    a: number;\n}", NONE);
    const b = normalized("// @public\nexport interface WorkflowCtx {\n    b: string;\n}", NONE);
    expect(a).not.toBe(b);
    expect(a).toContain("a: number");
  });

  test("a declaration NO capability owns is still hashed by body", () => {
    // `includeForgottenExports` puts these in the report precisely because a
    // consumer has to satisfy them while having no name to import them by.
    // Nothing else contracts their shape, so this is their only cover.
    const a = normalized("// @public\ninterface DelegateOptions {\n    task: string;\n}", foreign);
    const b = normalized("// @public\ninterface DelegateOptions {\n    task: number;\n}", foreign);
    expect(a).not.toBe(b);
  });

  test("a multi-declarator statement is foreign only if every name is", () => {
    const body = "// @public\ndeclare const WorkflowCtx: number, Mine: string;";
    expect(normalized(body, foreign)).toContain("Mine: string");
  });
});
