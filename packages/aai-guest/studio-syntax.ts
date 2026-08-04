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
 * dependency and no second notion of "valid". (TypeScript's own API is not an
 * option: TS 7 is the Go port and no longer exposes `createSourceFile`.)
 */

import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { errMsg } from "./harness-rpc.ts";

/** Extensions oxc can parse. JSON is skipped — it is not a script. */
const CHECKED = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"]);

type OxcTransformer = (code: string, filename: string) => Promise<unknown>;

/** `null` means "checked and unavailable" — distinct from "not yet loaded". */
let transformer: Promise<OxcTransformer | null> | null = null;

/**
 * Resolve vite's oxc transform from the workspace's own toolchain. A sandbox
 * without it simply skips the check rather than blocking every write.
 */
function loadTransformer(dir: string): Promise<OxcTransformer | null> {
  transformer ??= (async () => {
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(path.join(dir, "package.json"));
      const vite = (await import(require.resolve("vite"))) as {
        transformWithOxc?: OxcTransformer;
      };
      return vite.transformWithOxc ?? null;
    } catch {
      // No toolchain in this sandbox: skip the check rather than block writes.
      return null;
    }
  })();
  return transformer;
}

/** Reset the memoized parser (tests). */
export function resetSyntaxChecker(): void {
  transformer = null;
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
  if (!CHECKED.has(path.extname(file).toLowerCase())) return;
  const transform = await loadTransformer(dir);
  if (!transform) return;
  try {
    await transform(content, file);
  } catch (err) {
    return tidy(errMsg(err));
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
