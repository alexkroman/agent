// Copyright 2026 the AAI authors. MIT license.
/**
 * A COMPUTED step identity in the project's own `workflows/`.
 *
 * `guard-invariants` rule 32 is this same check over the repo's own shipped
 * template bodies; this is it pointed at a USER's project, at `aai build` and
 * `aai deploy`. The two exist together because the gate holds the examples and
 * held nothing written from them.
 *
 * It is also the half of rule 30 ("no clock, random number, uuid or network
 * read at body level") that ports at all — and the half the type system
 * provably leaves open.
 *
 * ## What it catches, and why the type does not
 *
 * `ctx.step`, `ctx.sleep` and `ctx.waitFor` all constrain their identity with
 * `Literal<Name>` (`string extends Name ? never : Name`), which rejects a name
 * that has widened to `string`. **A template literal passes it**: the type of
 * `` `charge-${coin}` `` is a template-literal type, not `string`, so this
 * compiles — and it is checked rather than claimed, `check:doc-examples`
 * compiling every fence in this repo's shipped docs:
 *
 * ```ts
 * import type { WorkflowCtx } from "@alexkroman1/aai";
 *
 * declare const charge: () => Promise<string>;
 *
 * export async function body(ctx: WorkflowCtx, coin: string): Promise<void> {
 *   // No error. The banned shape, against the real `WorkflowCtx`.
 *   await ctx.step(`charge-${coin}`, charge);
 * }
 * ```
 *
 * And it is exactly
 * the shape of the engine's own measured defect: a body-level `Math.random()`
 * feeding a step name executed the side effect twice in **7 of 10 runs, with
 * all 10 reporting `completed`** (`aai-runtime/workflow-replay-divergence.ts`).
 * Substitute "charge the customer" for the side effect.
 *
 * A computed identity has no legitimate use in this engine, which is what makes
 * the check cheap AND precise. Identity is `(name, occurrence)`: a fan-out
 * reuses ONE name and the per-name occurrence counter distinguishes the calls,
 * so every step in all fourteen shipped templates — the seven-way transcription
 * fan-out included — is a plain string literal. The scan finds zero occurrences
 * across them.
 *
 * ## Why rule 30's OTHER half is deliberately not ported
 *
 * That half scans for the reads themselves, anywhere in a `workflows/` file,
 * and it pays for the breadth with seven baselined occurrences in this repo.
 * Measured before writing this: a faithful port reports **all seven and nothing
 * else** — and all seven are correct code. Each is a read inside a step-called
 * helper (`timed`, `pollTranscript`, `file`), which `link-digest`'s own comment
 * explains: "the `ctx.step` callback boundary is not decidable from a line …
 * Anything at BODY level is the bug, not an exception."
 *
 * A user's project has no baseline to carry, so that port would be a 100%
 * false-positive rate on the only corpus anyone can measure — and a checker
 * that is always wrong is one an author learns to scroll past, which costs the
 * precise finding below as well as itself. Deciding that boundary needs a real
 * parse; the repo does that with `oxc-parser`
 * (`scripts/_test-assertions-parse.mjs`, whose doc argues it against the ~140
 * lines of hand-written lexer it replaced), and a native parser cannot join a
 * published CLI's runtime dependencies — a new one fails the artifact-size
 * budget on its own, regardless of bytes. So the reads half stays in the repo
 * gate, where the baseline mechanism it needs already exists.
 *
 * ## It WARNS
 *
 * `assertTypechecks` throws and `aai build` stops. This does not, because one
 * shape is legitimate: a name interpolating a CONSTANT (`` `${PREFIX}-fetch` ``
 * over a `const` string) is the same on every walk. It is rare enough not to
 * shape the message and real enough not to fail a build over.
 *
 * Same posture and the same call site as `agentConfigWarnings`, whose comment
 * in `build.ts` states it: "Legal, and worth saying".
 *
 * @module
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The three `ctx` methods whose first argument is a journal identity.
 *
 * All three key a journal row by it — `name#occurrence` for a step,
 * `sleep!<label>#<n>` and `hook!<token>#<n>` for the waits — so a computed one
 * mints a row no earlier walk reached in exactly the same way. Kept as a list
 * so the message can name the method that was called.
 */
const IDENTITY_METHODS: readonly string[] = ["step", "sleep", "waitFor"];

/**
 * A `ctx.<method>(` immediately followed by a BACKTICK.
 *
 * The whole check, and its narrowness is the point. A quoted literal is
 * accepted; a bare identifier is already the type system's job (`Literal<Name>`
 * refuses one that widened to `string`, and one that did not is a `const`
 * literal and deterministic); a template literal is what neither of them sees.
 *
 * The receiver is not pinned to `ctx` — a body may destructure or rename it —
 * and a `.step(` on anything else taking a template-literal first argument is
 * not a shape worth excluding.
 *
 * Shared rather than built per call, which is safe ONLY because the single
 * reader is `matchAll`: that method species-constructs its own clone and never
 * advances this object's `lastIndex`. A `.exec` or `.test` added against a `/g`
 * regex would carry state between lines — build a fresh one there.
 */
const IDENTITY_PATTERN = new RegExp(`\\.(${IDENTITY_METHODS.join("|")})\\(\``, "g");

/** Whether a template literal actually INTERPOLATES, or is merely quoted oddly. */
const INTERPOLATES = /\$\{/;

/** One computed identity the scan found. */
export type DeterminismFinding = {
  /** Relative to the project root, so a message is copy-pasteable. */
  file: string;
  /** 1-indexed, so `file:line` opens in an editor. */
  line: number;
  /** `step`, `sleep` or `waitFor` — which identity this is. */
  method: string;
  /** The source line, trimmed — what makes the warning actionable unopened. */
  text: string;
};

/**
 * Whether this line is only a comment.
 *
 * A method NAMED IN PROSE is prose: this module's own doc shows the banned
 * shape, and rule 30 carries the same skip for the same reason. Block-comment
 * continuations (`*`) count, which is what covers a paragraph rather than only
 * its first line.
 */
function isCommentOnly(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * Every computed identity in one source file.
 *
 * The interpolation is looked for in the REST of the line rather than inside a
 * balanced template: a template-literal name long enough to wrap is not a shape
 * this needs to resolve, and reporting one whose `${` sits on the next line is
 * the safer direction for a warning.
 */
export function findComputedIdentities(source: string, file: string): DeterminismFinding[] {
  const findings: DeterminismFinding[] = [];
  for (const [n, line] of source.split("\n").entries()) {
    if (isCommentOnly(line)) continue;
    for (const match of line.matchAll(IDENTITY_PATTERN)) {
      const method = match[1];
      if (method === undefined) continue;
      if (!INTERPOLATES.test(line.slice((match.index ?? 0) + match[0].length))) continue;
      findings.push({ file, line: n + 1, method, text: line.trim() });
    }
  }
  return findings;
}

/** Every workflow body under `cwd`, or nothing when the project declares none. */
async function workflowFiles(cwd: string): Promise<string[]> {
  const dir = path.join(cwd, "workflows");
  // NAMES, not `Dirent`s: `ReturnType<typeof readdir>` resolves to the buffer
  // overload's `Dirent<NonSharedBuffer>[]`, on which `entry.name.endsWith` is a
  // type error. A listing is the same read and needs no overload to be named.
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // No `workflows/` at all — the ordinary case for a voice agent, and not a
    // condition to report. A project's shape decides whether this has anything
    // to say.
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !(name.endsWith(".test.ts") || name.endsWith(".test-d.ts")))
    .map((name) => path.join("workflows", name));
}

/**
 * Scan the project's workflow bodies.
 *
 * FLAT, matching both the shape every template uses and rule 30's own pathspec
 * (`templates/*` + `/workflows/*.ts`). A nested file is missed, which is the
 * same gap the rule has; widening both together is the change to make, rather
 * than widening one and having the two disagree about their own corpus.
 *
 * A file that will not READ is skipped rather than failing the build: this is a
 * warning pass beside a typecheck that has already run on the same tree.
 */
export async function scanWorkflowDeterminism(cwd: string): Promise<DeterminismFinding[]> {
  // Read overlapped rather than one at a time — the files are independent, and
  // mapping (rather than pushing) keeps the report in `workflowFiles` order.
  const perFile = await Promise.all(
    (await workflowFiles(cwd)).map(async (rel) => {
      try {
        return findComputedIdentities(await readFile(path.join(cwd, rel), "utf-8"), rel);
      } catch {
        return [];
      }
    }),
  );
  return perFile.flat();
}

/**
 * The remedy, once, however many findings there are.
 *
 * Repeating it per finding is how a warning becomes a wall an author scrolls
 * past, and the fix is the same for all three methods. It names the OCCURRENCE
 * counter, because "use a literal" alone reads as a restriction on fan-outs —
 * the one case an author will think they need this for, and the case the
 * counter already handles.
 */
const REMEDY =
  "A workflow identity is a journal KEY, and a body is replayed — so a computed " +
  "one mints a key no earlier walk reached, and the engine either re-executes " +
  "the step or refuses the run. Measured on a one-line body: 7 of 10 runs ran " +
  "the side effect twice, all 10 reporting completed. Use a plain string " +
  "literal. A fan-out does not need a unique name: identity is (name, " +
  "occurrence), so N calls under one name are N distinct rows — " +
  'ctx.step("transcribeSegment", …) inside the loop is right.';

/**
 * One warning line per finding, plus the remedy — or nothing at all.
 *
 * Shaped as strings rather than printed here for the reason every reporter in
 * this package takes an injected one: `build` and `deploy` notify, and a spec
 * reads what an author would have seen without capturing stdout.
 */
export function determinismWarnings(findings: readonly DeterminismFinding[]): string[] {
  if (findings.length === 0) return [];
  return [
    ...findings.map(
      (found) =>
        `${found.file}:${found.line} computes a ctx.${found.method} identity: ${found.text}`,
    ),
    REMEDY,
  ];
}
