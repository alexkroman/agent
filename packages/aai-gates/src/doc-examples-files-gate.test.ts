// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Multi-file doc fences — `scripts/_doc-example-files.mjs`, run by
 * `scripts/check-doc-examples.mjs`.
 *
 * A fence may declare several files as `// file: <path>` sections, each written
 * at its path under the fence's own scratch directory so the relative imports
 * between them resolve. That is what let the SDK's "the point of the example is
 * the OTHER file" fragments stop being `no-check`. This suite is the guard
 * under it, for the reason every gate spec here exists: the gate's success
 * output is a checkmark, and a splitter that stopped recognising the marker
 * would compile each such fence as ONE file — a `tools/x.ts` importing
 * `../shared.ts` that does not exist — and the gate would go RED on every
 * converted example at once, which is loud; but a splitter that silently
 * dropped sections would go GREEN with less compiled, which is not.
 *
 * So the splitter is imported as a VALUE and fed samples, the gate is held to
 * importing it and to an `include` that reaches the section directories, and
 * the corpus is re-parsed here to prove the marker still has work to do.
 */

import { describe, expect, test } from "vitest";
import {
  DOC_EXAMPLE_MARKDOWN,
  DOC_EXAMPLES_SCRIPT,
  declaredMarkdown,
  docExamplesSource,
} from "./_doc-example-corpus.ts";
import { sole } from "./_gate-support.ts";

const FILES_MODULE = "scripts/_doc-example-files.mjs";

type Section = { path: string; code: string };
const splitExampleFiles = sole(
  import.meta.glob<(code: string, origin?: string) => Section[] | null>(
    "../../../scripts/_doc-example-files.mjs",
    { import: "splitExampleFiles", eager: true },
  ),
);

/** The checked ts/tsx fence bodies of one markdown document. */
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

describe("splitExampleFiles", () => {
  test("a fence with no marker is one file", () => {
    expect(splitExampleFiles('import { agent } from "@alexkroman1/aai";\n')).toBeNull();
  });

  test("each section lands at the path it names, in order, with its own code", () => {
    const fence = [
      "// file: shared.ts",
      "export const cart = 1;",
      "",
      "// file: tools/add_item.ts",
      'import { cart } from "../shared.ts";',
      "export default cart;",
    ].join("\n");
    expect(splitExampleFiles(fence)).toEqual([
      { path: "shared.ts", code: "export const cart = 1;\n" },
      {
        path: "tools/add_item.ts",
        code: 'import { cart } from "../shared.ts";\nexport default cart;',
      },
    ]);
  });

  test("blank lines before the first marker are fine; code is not", () => {
    expect(splitExampleFiles("\n// file: a.ts\nexport {};")).toEqual([
      { path: "a.ts", code: "export {};" },
    ]);
    expect(() => splitExampleFiles("const x = 1;\n// file: a.ts\n", "doc.md:3")).toThrow(
      /doc\.md:3 has code before its first `\/\/ file:` marker/,
    );
  });

  test.each([
    ["../escape.ts", /leaves the example/],
    ["/abs.ts", /leaves the example/],
    ["notes.md", /not a \.ts or \.tsx file/],
  ])("refuses `// file: %s`", (path, message) => {
    expect(() => splitExampleFiles(`// file: ${path}\nexport {};`)).toThrow(message);
  });

  test("refuses a path named twice", () => {
    expect(() => splitExampleFiles("// file: a.ts\n// file: a.ts\n")).toThrow(/named twice/);
  });

  test("a marker is the WHOLE line — a caption mentioning a file is not one", () => {
    const caption = "// tools/quote_claim.ts — cannot run before the caller is verified.\n";
    expect(splitExampleFiles(caption)).toBeNull();
  });
});

describe("the gate is wired to it", () => {
  test(`${DOC_EXAMPLES_SCRIPT} imports the splitter and compiles the section directories`, () => {
    expect(docExamplesSource).toBeTypeOf("string");
    const source = docExamplesSource ?? "";
    expect(source).toContain(`from "./${FILES_MODULE.replace("scripts/", "")}"`);
    expect(source).toContain("splitExampleFiles(ex.code");
    // `**`, or a section under `example-N/` is never handed to tsc.
    expect(source).toMatch(/include: \[path\.join\(scratch, "\*\*\/\*\.ts"\)/);
  });

  test("the corpus still carries multi-file fences, so the marker has work to do", () => {
    const readable = declaredMarkdown().filter((file) => DOC_EXAMPLE_MARKDOWN[file] !== undefined);
    expect(readable.length).toBeGreaterThan(0);
    const multiFile = readable.flatMap((file) =>
      checkedFences(DOC_EXAMPLE_MARKDOWN[file] ?? "")
        .map((code) => splitExampleFiles(code, file))
        .filter((files): files is Section[] => files !== null),
    );
    expect(multiFile.length).toBeGreaterThanOrEqual(1);
    for (const files of multiFile) {
      expect(files.length).toBeGreaterThanOrEqual(2);
    }
  });
});
