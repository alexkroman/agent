// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Where a doc example's AMBIENTS come from — `scripts/check-doc-examples.mjs`
 * and `scripts/_doc-example-ambients.mjs`.
 *
 * That gate compiles every ```ts fence in the corpus as ONE TypeScript program,
 * which is what makes it cheap and what used to make a fence's ambients a
 * property of the CORPUS rather than of the harness: a
 * `/// <reference types="vite/client" />` written inside four
 * `scaffold/CLAUDE.md` fences augmented `ImportMeta` for all 193 compiled
 * fences. A fence in one package could be green because of a sibling in
 * another, and red the moment that sibling was edited — and nothing asserted
 * otherwise, because a leak makes a gate PASS.
 *
 * Two changes closed it: the ambients a real `aai init` project gets — once
 * `scaffold/global.d.ts`, now the `@alexkroman1/aai/tsconfig` preset's
 * `vite/client` type and its `presets/agent-env.d.ts` — joined the program,
 * and the directives are now stripped out of each fence on the way to the
 * scratch tree. This suite is the guard under both halves, and it holds three
 * things a green gate cannot say for itself:
 *
 *   - **the stripper still strips.** It is imported as a REAL VALUE and fed
 *     samples, the way `guard-invariants-gate.test.ts` imports `LINE_RULES`
 *     rather than scraping them — a matcher that had gone blind would leave
 *     every directive in place and the gate would print the same checkmark it
 *     prints today, since the ambients would simply arrive by leakage again;
 *   - **it has work to do.** The corpus is re-parsed here, with its own fence
 *     parser, and at least one CHECKED fence must still carry a directive.
 *     A stripper matching nothing is the dead-pattern failure every gate spec
 *     in this package exists to catch;
 *   - **the harness is what carries the ambient.** `vite/client` in the
 *     generated config's `types`, and the preset it extends, are load-bearing
 *     rather than belt-and-braces: A/B'd 2026-09-01 by deleting the then
 *     `global.d.ts` entry with stripping on, the gate reported **12 failures**,
 *     the four `scaffold/CLAUDE.md` `client.tsx` fences that used to supply the
 *     ambient themselves among them (`TS2882` on
 *     `import "@alexkroman1/aai-ui/styles.css"`).
 *
 * It reads its subject as TEXT (`?raw`, eager) rather than importing it: this
 * package's tsconfig pulls in no node types, and a spec that imported the
 * docExamplesSource it guards would be asserting a module against itself.
 */

import { describe, expect, test } from "vitest";
import {
  DOC_EXAMPLE_MARKDOWN,
  DOC_EXAMPLES_SCRIPT,
  declaredMarkdown,
  docExamplesSource,
} from "./_doc-example-corpus.ts";
import { GATE_WIRING, sole } from "./_gate-support.ts";

const AMBIENTS_MODULE = "scripts/_doc-example-ambients.mjs";
const PRESET = "packages/aai/presets/tsconfig.agent.json";
const AGENT_ENV_DTS = "packages/aai/presets/agent-env.d.ts";
const SCAFFOLD_TSC = "scripts/_scaffold-tsc.mjs";

/** The harness transformation, read as SOURCE — for the wiring assertions. */
const ambientsSource = sole(
  import.meta.glob("../../../scripts/_doc-example-ambients.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/**
 * …and the same module as a VALUE.
 *
 * The whole point of the split being a real module (see its own doc) is that a
 * spec can exercise it instead of asserting that its source still contains a
 * regex. A scrape agrees with a matcher that matches nothing; a call does not.
 */
type StripResult = { code: string; stripped: number };
const stripReferenceDirectives = sole(
  import.meta.glob<(code: string) => StripResult>("../../../scripts/_doc-example-ambients.mjs", {
    import: "stripReferenceDirectives",
    eager: true,
  }),
);

/** The ambients themselves, so "the preset still carries them" is checkable. */
const preset = sole(
  import.meta.glob("../../aai/presets/tsconfig.agent.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);
const agentEnvDts = sole(
  import.meta.glob("../../aai/presets/agent-env.d.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);
/** The shared harness, which must EXTEND the preset for its `files` to arrive. */
const scaffoldTscSource = sole(
  import.meta.glob("../../../scripts/_scaffold-tsc.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/**
 * Every CHECKED ts/tsx fence body in one document.
 *
 * Written from the markdown spec rather than copied from the gate, on the rule
 * its sibling states: a copy of the gate's own matcher would agree with it about
 * a fence neither of them can see.
 */
function checkedFences(source: string): string[] {
  const bodies: string[] = [];
  let open: string[] | null = null;
  for (const line of source.split("\n")) {
    const fence = /^\s*```(\S*)\s*(.*)$/.exec(line);
    if (open === null) {
      if (fence && /^tsx?$/.test(fence[1] ?? "") && !(fence[2] ?? "").includes("no-check")) {
        open = [];
      }
      continue;
    }
    if (fence) {
      bodies.push(open.join("\n"));
      open = null;
    } else {
      open.push(line);
    }
  }
  return bodies;
}

/** The declared documents this suite can actually READ. Asserted TOTAL below. */
const readable = declaredMarkdown().filter((file) => DOC_EXAMPLE_MARKDOWN[file] !== undefined);

/** The checked fences of every document this suite can both READ and prove the gate reads. */
const corpus = readable.flatMap((file) =>
  checkedFences(DOC_EXAMPLE_MARKDOWN[file] ?? "").map((code) => ({ file, code })),
);

/** A leading-trivia reference directive, re-derived — the property under test. */
function leadingDirectives(code: string): string[] {
  const found: string[] = [];
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (/^\/\/\//.test(line)) {
      if (/<reference\s/.test(line)) found.push(line);
      continue;
    }
    if (line.startsWith("//")) continue;
    break;
  }
  return found;
}

describe("the ambient stripper's wiring", () => {
  test("both sources are readable, and the module is importable", () => {
    expect(docExamplesSource, `${DOC_EXAMPLES_SCRIPT} not found`).toBeTypeOf("string");
    expect(ambientsSource, `${AMBIENTS_MODULE} not found`).toBeTypeOf("string");
    // The module must stay side-effect-free to be importable at all; a top-level
    // read or a `process.exit` here would fail this line rather than the suite.
    expect(stripReferenceDirectives, `${AMBIENTS_MODULE} no longer exports it`).toBeTypeOf(
      "function",
    );
  });

  test("the entry point still RUNS it on every fence it writes", () => {
    // The split is for file size; the wiring is what makes it a transformation.
    // A module nothing calls leaves the leak open with no diff saying so.
    expect(
      docExamplesSource,
      `${DOC_EXAMPLES_SCRIPT} no longer imports ${AMBIENTS_MODULE}`,
    ).toContain("_doc-example-ambients.mjs");
    expect(docExamplesSource, `${DOC_EXAMPLES_SCRIPT} no longer calls the stripper`).toContain(
      "stripReferenceDirectives(ex.code)",
    );
    expect(
      docExamplesSource,
      `${DOC_EXAMPLES_SCRIPT} no longer reports how many it stripped`,
    ).toContain("directivesStripped");
  });

  test("the gate that carries it is enforced by both runners", () => {
    // Same argument as every other gate spec here: a gate in package.json but in
    // neither runner is a docExamplesSource nobody runs. This transformation rides the
    // EXISTING `check:doc-examples` row rather than adding a name to keep in
    // step across files.
    const wiring = Object.entries(GATE_WIRING);
    expect(wiring.length, "GATE_WIRING resolved to nothing").toBeGreaterThanOrEqual(2);
    for (const [file, source] of wiring) {
      expect(source, `${file} not found`).toBeTypeOf("string");
      expect(source, `${file} no longer names check:doc-examples`).toContain("check:doc-examples");
    }
  });
});

describe("the harness owns the ambients, not a sibling fence", () => {
  test("the scaffold's ambients are in the program, and the preset still carries them", () => {
    // The load-bearing pair. A/B'd 2026-09-01 with stripping ON: delete the
    // ambient source (then `scaffold/global.d.ts`) and the gate reports 12
    // failures, four of them the scaffold/CLAUDE.md `client.tsx` fences that
    // used to supply the ambient themselves. So this is not redundancy with
    // the stripping — it is the replacement for the leak.
    //
    // Matched as the EXPRESSION, not as a bare name: the script discusses
    // `vite/client` in its comments, so a `toContain` would pass with the real
    // entry deleted — a spec satisfied by the prose ABOUT the mechanism it is
    // checking, which is the self-referential trap `guard-invariants.mjs` keeps
    // its own set for.
    expect(
      docExamplesSource ?? "",
      `${DOC_EXAMPLES_SCRIPT} no longer puts Vite's client types in the program`,
    ).toMatch(/types:\s*\[\s*"node",\s*VITE_CLIENT_TYPES\s*\]/);
    expect(
      scaffoldTscSource ?? "",
      `${SCAFFOLD_TSC} no longer extends the scaffold's preset, so its files entry is lost`,
    ).toMatch(/extends:\s*scaffold\.extends,/);
    expect(preset, `${PRESET} not found`).toBeTypeOf("string");
    expect(preset, `${PRESET} no longer names vite/client in types`).toMatch(
      /"types":\s*\[[^\]]*"vite\/client"/,
    );
    expect(preset, `${PRESET} no longer loads agent-env.d.ts`).toMatch(
      /"files":\s*\[\s*"\.\/agent-env\.d\.ts"\s*\]/,
    );
    // The other ambient the fences depend on.
    expect(agentEnvDts, `${AGENT_ENV_DTS} no longer declares virtual:aai/agent`).toContain(
      'declare module "virtual:aai/agent"',
    );
  });

  test("the corpus resolves to something", () => {
    // The floor every gate spec here carries: a directive is stripped from no
    // fence at all if there are no fences, and "none leaks" is vacuously true
    // of an empty corpus.
    expect(declaredMarkdown().length, "MARKDOWN_FILES parsed to nothing").toBeGreaterThanOrEqual(8);
    expect(corpus.length, "no checked ts/tsx fence was readable").toBeGreaterThan(30);
    // The intersection is TOTAL, and asserting so is the half the floor above
    // cannot cover: a document the gate declares and this file's five literal
    // globs cannot reach used to drop out silently, leaving the fence floor
    // satisfied by the other documents and that one's directives unchecked.
    expect(readable).toEqual(declaredMarkdown());
  });

  test("the stripper still has work to do", () => {
    // Non-vacuity, and the assertion this file exists for. Measured 2026-09-01:
    // 4 — the `client.tsx` fences in scaffold/CLAUDE.md, which keep their
    // directives ON THE PAGE deliberately: a reader may paste the fence into a
    // project whose tsconfig does not extend the preset, where the directive
    // is what types the import. If this ever reaches zero the stripping is dead code: either the
    // teaching directives were removed from the docs — put them back, the fence
    // a reader copies has to be the fence a project can compile — or the
    // transformation has genuinely become unnecessary and should be DELETED
    // rather than left printing a checkmark over nothing.
    const carrying = corpus.filter((fence) => leadingDirectives(fence.code).length > 0);
    expect(
      carrying.length,
      "no checked fence carries a leading `/// <reference` — the stripper matches nothing",
    ).toBeGreaterThan(0);
  });

  test("no fence the harness writes can augment the program", () => {
    // The invariant itself, over the real implementation: whatever a fence
    // carried, what reaches the scratch tree has no leading-trivia directive —
    // which is the only kind TypeScript honours (verified against this repo's
    // tsc with an empty `typeRoots`, where an unresolvable directive is a
    // visible `TS2688`: reported above the first statement, absent after one
    // and absent inside a template literal).
    const strip = stripReferenceDirectives;
    expect(strip).toBeTypeOf("function");
    if (strip === undefined) return;
    let total = 0;
    for (const fence of corpus) {
      const result = strip(fence.code);
      total += result.stripped;
      expect(
        leadingDirectives(result.code),
        `${fence.file}: a reference directive survived the harness transformation`,
      ).toEqual([]);
    }
    // Both parsers looked at the same fences, so their counts must agree.
    const expected = corpus.reduce((sum, fence) => sum + leadingDirectives(fence.code).length, 0);
    expect(total, "the stripper and this suite's parser disagree").toBe(expected);
  });

  test("line numbers survive, because tsc reports (line,col) and only the PATH is rewritten", () => {
    // A directive is BLANKED rather than removed. Deleting the line would shift
    // every diagnostic under it, silently misattributing a real error to the
    // wrong line of a doc a reader is holding.
    const strip = stripReferenceDirectives;
    if (strip === undefined) return expect.fail(`${AMBIENTS_MODULE} export not importable`);
    const code = ['/// <reference types="vite/client" />', 'import "x";', "const a = 1;"].join(
      "\n",
    );
    const result = strip(code);
    expect(result.stripped).toBe(1);
    expect(result.code.split("\n")).toEqual(["", 'import "x";', "const a = 1;"]);
  });
});

describe("what the stripper matches, and what it spares", () => {
  const strip = (code: string): StripResult => {
    if (stripReferenceDirectives === undefined) {
      throw new Error(`${AMBIENTS_MODULE} export not importable`);
    }
    return stripReferenceDirectives(code);
  };

  test.each([
    ["a bare directive", '/// <reference types="vite/client" />'],
    ["an indented one", '  /// <reference types="node" />'],
    ["the `path` form", '/// <reference path="../bogon.d.ts" />'],
    ["the `lib` form", '/// <reference lib="dom" />'],
    ["no space before the slash", '/// <reference types="node"/>'],
    ["extra inner space", '///   <reference   types="node"   />'],
  ])("strips %s", (_label, line) => {
    const result = strip(`${line}\nexport const a = 1;\n`);
    expect(result.stripped).toBe(1);
    expect(result.code).not.toContain("<reference");
  });

  test("strips a directive that follows ordinary line comments", () => {
    // The real shape in `scaffold/CLAUDE.md`, whose fences open with a
    // `// \`no-check\`: …` note. Line comments are still leading trivia, so
    // TypeScript honours a directive under them and so must this.
    const result = strip(
      [
        "// a note about the example",
        "",
        '/// <reference types="vite/client" />',
        "export {};",
      ].join("\n"),
    );
    expect(result.stripped).toBe(1);
  });

  test("strips one that follows a block comment", () => {
    const result = strip(
      ["/*", " * a licence header", " */", '/// <reference types="node" />', "export {};"].join(
        "\n",
      ),
    );
    expect(result.stripped).toBe(1);
  });

  test.each([
    ["prose that merely QUOTES a directive", '// see `/// <reference types="node" />`'],
    ["a JSDoc line naming one", ' * plus a `/// <reference types="vite/client" />`'],
    ["a directive with no closing slash", '/// <reference types="node">'],
    ["a triple-slash comment that is not a reference", "/// just a comment"],
  ])("spares %s", (_label, line) => {
    // The mirror of the cast patterns in `check-escape-hatches.mjs`, which skip
    // comment-only lines: a directive named in prose is prose, and this corpus
    // documents its own harness — `sdk/testing-discovery.ts` and
    // `host/testing-vite.ts` both name that exact line inside a doc comment.
    const result = strip(`${line}\nexport const a = 1;\n`);
    expect(result.stripped).toBe(0);
    expect(result.code).toBe(`${line}\nexport const a = 1;\n`);
  });

  test.each([
    [
      "past the first statement",
      ["export const a = 1;", '/// <reference types="node" />', "export {};"],
    ],
    ["inside a template literal", ["export const s = `", '/// <reference types="node" />', "`;"]],
  ])("leaves an INERT directive %s alone", (_label, lines) => {
    // Not an oversight — the scope IS TypeScript's rule, so a directive the
    // compiler ignores needs no rewriting, and stopping at the first statement
    // is what makes a template literal cost no bookkeeping. Verified against
    // this repo's tsc: with an empty `typeRoots`, a leading
    // `/// <reference types="node" />` reports `TS2688` and neither of these
    // does, i.e. neither is resolved at all.
    const code = lines.join("\n");
    const result = strip(code);
    expect(result.stripped).toBe(0);
    expect(result.code).toBe(code);
  });
});
