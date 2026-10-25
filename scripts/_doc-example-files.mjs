// Copyright 2026 the AAI authors. MIT license.
/**
 * A doc fence that is SEVERAL files — the harness half of `// file:` sections.
 *
 * `scripts/check-doc-examples.mjs` compiles every ```ts fence as one scratch
 * module, which fits an example that is one file and nothing an agent project
 * actually looks like: a `tools/add_item.ts` reading a slot from
 * `../shared.ts`, a `workflows/digest.ts` beside the `agent.ts` that declares
 * it, a spec importing the tool it runs. Those were the bulk of the `no-check`
 * population — 46 fences in the SDK alone, most saying "the point of the
 * example is the OTHER file, so it cannot be self-contained". The fix is to
 * let a fence CARRY the other file:
 *
 * ```text
 * // file: shared.ts
 * export const cart = sessionSlot("cart", () => ({ items: [] as string[] }));
 *
 * // file: tools/add_item.ts
 * import { cart } from "../shared.ts";
 * export default cart.updateTool({ … });
 * ```
 *
 * Each section is written under its own directory in the scratch tree, at the
 * path it names, so the relative imports between them resolve exactly as they
 * would in a project, and every file still compiles as part of the ONE program
 * the gate runs (the measured reason there is no per-fence `tsc`, in
 * `_doc-example-ambients.mjs`). A fence with no marker is one file, as before.
 *
 * The marker is the whole line `// file: <path>`. It is a comment, so the fence
 * renders as the reader expects, and the path reads as the caption it already
 * was in half the corpus (`// tools/quote_claim.ts — cannot run before …`).
 * Text before the first marker is refused rather than guessed at — a fence is
 * either one file or all sections — and so is a path that leaves the example
 * (`../`), is absolute, is not a TypeScript file, or repeats.
 *
 * Its own module for the reason `_doc-example-ambients.mjs` is: the gate is a
 * single entry point already at its length, and a pure function with no reads
 * is what a spec can feed samples to (`doc-examples-files-gate.test.ts`).
 */

/** The marker, anchored: a comment that is ONLY the path. */
const FILE_MARKER = /^\/\/ file: (\S+)\s*$/;

/**
 * Why a section path is refused, or `undefined` when it is fine.
 *
 * @param {string} path
 * @param {Set<string>} seen the paths already declared in this fence
 * @returns {string | undefined}
 */
function pathProblem(path, seen) {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    return "leaves the example — a section's path is relative to the fence and stays inside it";
  }
  if (!/\.tsx?$/.test(path)) return "is not a .ts or .tsx file, so the compiler would not read it";
  return seen.has(path) ? "is named twice" : undefined;
}

/**
 * Split one fence body into the files it declares.
 *
 * Returns `null` for a single-file fence (no marker anywhere), otherwise one
 * `{ path, code }` per section in order. Throws on a shape the harness will
 * not guess at; the message names the fence so the gate can say which.
 *
 * @param {string} code the fence body, as extracted
 * @param {string} origin where it came from, for the error message
 * @returns {{ path: string, code: string }[] | null}
 */
export function splitExampleFiles(code, origin = "<fence>") {
  const lines = code.split("\n");
  if (!lines.some((line) => FILE_MARKER.test(line))) return null;
  /** @type {{ path: string, code: string[] }[]} */
  const files = [];
  const seen = new Set();
  for (const line of lines) {
    const path = line.match(FILE_MARKER)?.[1];
    if (path !== undefined) {
      const problem = pathProblem(path, seen);
      if (problem)
        throw new Error(`check-doc-examples: ${origin} \`// file: ${path}\` ${problem}.`);
      seen.add(path);
      files.push({ path, code: [] });
    } else if (files.length > 0) {
      files.at(-1)?.code.push(line);
    } else if (line.trim() !== "") {
      throw new Error(
        `check-doc-examples: ${origin} has code before its first \`// file:\` marker — ` +
          "a multi-file fence is all sections; a single file needs no marker.",
      );
    }
  }
  return files.map((file) => ({ path: file.path, code: file.code.join("\n") }));
}
