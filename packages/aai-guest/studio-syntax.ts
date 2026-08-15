// Copyright 2026 the AAI authors. MIT license.
/**
 * Refusing to persist a source file that does not parse.
 *
 * Observed: a `write_file` reported "Wrote agent.ts (4863 bytes)" for content
 * whose string literals were over-escaped (`\"` where `"` belonged). Nothing
 * noticed until `test_agent` ran a full build; by then `edit_file` could not
 * match anything the agent believed it had written, and the turn died looping
 * read → edit → "could not find that text" until the step cap. Sixteen steps,
 * no agent produced.
 *
 * This is opencode's trick — it runs LSP diagnostics immediately after every
 * edit — in the cheap form available here: a syntax-only parse at the moment
 * of the write, while the agent still knows what it meant. Weaker than full
 * diagnostics (no types, no unresolved imports) but it catches the class that
 * is unrecoverable, because a file that does not parse cannot be edited back
 * into shape by text matching.
 *
 * Type errors are deliberately NOT caught here: a file can legitimately be
 * mid-refactor and not yet type-correct, and the post-write diagnostics
 * (studio-write-diagnostics.ts) / `test_agent` already own that — reported,
 * never blocking. Unparseable is different — it is never a valid
 * intermediate state.
 *
 * The parser is oxc, reached through vite's `transformWithOxc` — the same one
 * the real build runs, already in the guest toolchain, so there is no new
 * dependency and no second notion of "valid".
 *
 * TypeScript's own parser is now reachable again — TS 7.0 ships `typescript/
 * unstable/ast` (scanner, parser, factory, visitor) alongside `unstable/sync`
 * and `unstable/async`, so the note that used to sit here ("TS 7 is the Go
 * port and no longer exposes `createSourceFile`") is out of date. oxc stays
 * anyway, on the stronger of the two original reasons: it is the parser the
 * real build uses, so "parses here" and "builds there" cannot disagree, and
 * those subpaths are explicitly unstable.
 */

import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { errorMessage } from "@alexkroman1/aai";

/**
 * Extensions oxc can parse — and, because they are the same set, the ones a
 * post-write type check and a post-copy check can vouch for. JSON is skipped:
 * it is not a script.
 *
 * ONE definition. It was written out three times (here,
 * `studio-write-diagnostics.ts`, `studio-template-tools.ts`), two of them with a
 * comment claiming to mirror one of the others — which is the shape a set takes
 * just before it stops mirroring.
 */
const SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"]);

/** Is this workspace-relative path something a parser or `tsc` can speak for? */
export function isScriptFile(file: string): boolean {
  return SCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

type OxcTransformer = (code: string, filename: string) => Promise<unknown>;

/** The memoized resolve. Rejects — and clears itself — when it cannot resolve. */
let transformer: Promise<OxcTransformer> | null = null;

/**
 * Resolve vite's oxc transform from the workspace's own toolchain. A sandbox
 * without it simply skips the check rather than blocking every write.
 *
 * RESET ON FAILURE, exactly as `loadToolchain` does in `studio-build.ts`, and
 * for a sharper reason: the failure is not only "this image has no toolchain",
 * which is permanent. `createRequire` is anchored at the WORKSPACE, and the
 * workspace is re-materialized on every page open — so a resolve racing a
 * session re-install can fail transiently. Caching the `null` that came back
 * from one such moment disabled the write-time syntax gate for the life of the
 * process, silently: every later write was accepted unparsed, which is the one
 * failure this module exists to prevent. The cost of retrying is a
 * `require.resolve` that throws, per write, in a sandbox that genuinely has no
 * toolchain — and that sandbox cannot build or type-check either.
 */
function loadTransformer(dir: string): Promise<OxcTransformer> {
  transformer ??= (async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(path.join(dir, "package.json"));
    const vite = (await import(require.resolve("vite"))) as {
      transformWithOxc?: OxcTransformer;
    };
    if (!vite.transformWithOxc) throw new Error("vite exports no transformWithOxc");
    return vite.transformWithOxc;
  })().catch((err: unknown) => {
    transformer = null;
    throw err;
  });
  return transformer;
}

/** oxc renders a boxed, ANSI-coloured diagnostic; keep the useful lines. */
function tidy(message: string): string {
  const plain = stripVTControlCharacters(message);
  const lines = plain
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[╭╰│─]+$/.test(l));
  return lines.slice(0, 6).join("\n");
}

/**
 * A syntax error in `content`, or undefined when it parses (or cannot be
 * checked). Never throws: a broken checker must not block writes.
 */
export async function syntaxError(
  dir: string,
  file: string,
  content: string,
): Promise<string | undefined> {
  if (!isScriptFile(file)) return;
  let transform: OxcTransformer;
  try {
    transform = await loadTransformer(dir);
  } catch {
    // No toolchain reachable right now: skip the check rather than block writes.
    return;
  }
  try {
    await transform(content, file);
  } catch (err) {
    return tidy(errorMessage(err));
  }
}

/** The message a rejected write returns — states the fix, not just the fault. */
export function formatRejection(file: string, detail: string): string {
  return (
    `Error: refused to write ${file} — it does not parse, so NOTHING was saved ` +
    `and the file on disk is unchanged:\n\n${detail}\n\n` +
    "Send the whole file again with the syntax fixed, and do NOT run " +
    "test_agent first — there is nothing new to test. A common cause is " +
    'over-escaping: the content should contain `"`, not `\\"` — the tool call ' +
    "is already JSON, so the file content must not be escaped a second time."
  );
}
