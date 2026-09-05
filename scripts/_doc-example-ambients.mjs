// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a doc example's AMBIENT declarations come from — the harness, never a
 * sibling fence.
 *
 * `scripts/check-doc-examples.mjs` compiles every ```ts fence in the corpus as
 * ONE TypeScript program. That is what makes the gate cheap, and it used to make
 * a fence's ambients a property of the CORPUS: a
 * triple-slash reference to Vite's client types written inside four
 * `scaffold/CLAUDE.md` fences augmented `ImportMeta` for all 193 compiled
 * fences, so a fence in one package could be green because of a sibling in
 * another, and red the moment that sibling was edited.
 *
 * `scaffold/global.d.ts` — the file a real `aai init` project ships, carrying
 * that same reference — is in the program's `include` now, which made the
 * leakage unnecessary. This module is what makes it IMPOSSIBLE: the directives
 * are stripped on the way to the scratch tree.
 *
 * **MEASURED 2026-09-01, four ways over 186 fences:**
 *
 * | | inline `///` refs | `global.d.ts` | result |
 * | --- | --- | --- | --- |
 * | A | kept | on | green, 391 ms |
 * | B | **stripped** | **on** | **green, 446 ms** |
 * | C | kept | off | 5 failures |
 * | D | stripped | off | 11 failures |
 *
 * Run B is the finding: with `global.d.ts` in the program no fence depends on
 * cross-fence leakage any more — `README.md:368` and
 * `packages/aai-ui/README.md:26`, which had been living on the leak, now stand
 * on the harness. Stripping costs the ~55 ms between A and B and turns "absent
 * today" into "unrepresentable".
 *
 * Run D re-measured on the shipped implementation, corpus now 193 compiled
 * fences: **12 failures**, and the interesting half is WHICH — the four
 * `scaffold/CLAUDE.md` `client.tsx` fences that used to carry the directive
 * themselves are among them, on `TS2882` for
 * `import "@alexkroman1/aai-ui/styles.css"`. That is the proof that
 * `global.d.ts` is genuinely carrying the ambient rather than merely being
 * present, so dropping it from the `include` is now a red gate rather than a
 * silent return to leakage.
 *
 * Full per-fence ISOLATION was measured in the same sitting and deliberately
 * NOT implemented: one `tsc` per fence, 186 programs, **0 additional failures
 * for 21.7 s against 0.39 s** — a ~55x cost on every `pnpm check` and every CI
 * run, buying nothing this does not.
 *
 * It is its own module for the reason `_no-check-ratchet.mjs` is: the gate is at
 * its file-length cap. The seam is real either way — this is what the harness
 * does TO a fence, where the gate finds fences and runs the compiler — and it
 * buys one thing a scrape cannot,
 * `packages/aai-gates/src/doc-examples-ambient-gate.test.ts` importing the real
 * function and feeding it samples. So this module has NO side effects and reads
 * nothing: it must stay importable.
 */

/**
 * A whole-line `/// <reference … />` directive, and nothing that merely QUOTES
 * one.
 *
 * The cast patterns in `check-escape-hatches.mjs` skip comment-only lines for
 * the mirror-image reason, and this corpus is full of prose about directives:
 * `sdk/testing-discovery.ts` and `host/testing-vite.ts` both name this exact
 * line inside a doc comment, so a substring match would rewrite documentation
 * ABOUT the harness as though it were input to it.
 *
 * Deliberately NOT exported: a spec asserting the pattern would agree with a
 * pattern that matches nothing, which is the whole failure this module's guard
 * exists to rule out. It is reached through the function, with samples.
 */
const REFERENCE_DIRECTIVE = /^\/\/\/\s*<reference\s[^>]*\/>$/;

/**
 * Blank the `/// <reference … />` directives in a fence's LEADING TRIVIA.
 *
 * This is a harness transformation, applied on the way to the scratch tree and
 * nowhere else. The fence on the PAGE keeps its directives, because they teach a
 * convention a scaffolded project really uses — `scaffold/global.d.ts` opens
 * with that very line — and editing what a reader sees to satisfy a compiler we
 * chose to run would be the wrong direction entirely.
 *
 * **Scoped to leading trivia because that is TYPESCRIPT's own rule**, which
 * makes the scan exactly as wide as the hole. Verified against this repo's tsc
 * with an empty `typeRoots`, where an unresolvable directive surfaces as a
 * visible `TS2688`: a directive above the first statement reports it, while the
 * same directive AFTER a statement, or inside a template literal, reports
 * nothing — it is inert. So a template literal costs no bookkeeping here;
 * nothing has opened yet where the scan stops. Where the scan is imprecise (a
 * block comment closing on a line that also carries code) it over-strips into
 * that inert territory, which is the cheap error — the same trade
 * `RACE_CONTINUES` in `guard-invariants-ere.mjs` makes.
 *
 * Directive lines are BLANKED rather than removed: tsc reports `(line,col)` and
 * the gate rewrites only the PATH in a diagnostic, so deleting a line would
 * misreport every diagnostic under it.
 *
 * @param {string} code A fence's body, exactly as extracted.
 * @returns {{ code: string, stripped: number }} The body to compile, and how
 *   many directives it was carrying.
 */
export function stripReferenceDirectives(code) {
  const lines = code.split("\n");
  let stripped = 0;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    // `///` starts with `//`, so the directive test belongs in this branch.
    if (line === "" || line.startsWith("//")) {
      if (REFERENCE_DIRECTIVE.test(line)) {
        lines[i] = "";
        stripped += 1;
      }
      continue;
    }
    if (line.startsWith("/*")) {
      inBlockComment = !line.includes("*/");
      continue;
    }
    break;
  }
  return { code: lines.join("\n"), stripped };
}
