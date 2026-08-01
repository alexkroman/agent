// Copyright 2026 the AAI authors. MIT license.
/**
 * Turning tsc diagnostics into diagnostics the coding agent can act on.
 *
 * Measured across the studio starter prompts, a handful of TypeScript codes
 * account for most of the repair rounds — and they repeat because a bare
 * diagnostic states what is wrong without stating the idiom that fixes it.
 * The agent then guesses, guesses again, and burns its step budget.
 *
 * The obvious remedies both have a flaw. Putting the idioms in the system
 * prompt charges every request for guidance almost every request does not
 * need, and prompt text is demonstrably skippable. Putting them behind a
 * lookup tool assumes the agent knows to ask, which the same evidence says
 * it often does not — most tools are never called at all.
 *
 * So the hint rides on the failure itself: zero tokens until it fires, and
 * unmissable when it does, because it arrives inside the error the agent is
 * already reading. One hint per distinct code, appended once, so a file with
 * forty instances of the same mistake does not produce forty paragraphs.
 */

/** Hint per diagnostic code — keyed on the codes the evals actually surfaced. */
const HINTS: Record<string, string> = {
  // Indexing an object literal with a variable. By far the most expensive
  // one: it also causes the TS2339 cascade below.
  TS7053:
    "Annotate the lookup table instead of letting it infer: " +
    "`const ROOMS: Record<string, Room> = { ... }` (declare `type Room` first). " +
    "Without it TypeScript infers a union of each entry's literal shape, so " +
    "indexing with a variable fails and any field missing from one entry fails too.",
  TS2538: "Same fix as TS7053: annotate the map as `Record<string, T>`.",
  TS2339:
    "If the type is `never`, see the `null`/`[]` note below — the variable was " +
    "declared empty and filled inside a callback, so it never widened. " +
    "Otherwise, if this is a value read out of an object literal map, the map needs " +
    "`Record<string, T>` with `T` declaring every field (optional ones as `field?: X`). " +
    "Without it the inferred type is a union of the entries and only fields common to all of them exist.",
  // The `null`/`[]` widening family. TypeScript widens `let x = null` and
  // `const xs = []` as you assign to them — but that inference is control-flow
  // based and stops dead at a function boundary, so populating them inside a
  // `.forEach`/`.map`/`.filter` callback leaves them `null` and `never[]`.
  // This produced a four-round repair loop on one starter, re-reporting the
  // same line each time, because none of the three codes it raises says what
  // the actual rule is.
  TS2322:
    "If the target is `null`, this is a `let x = null` being assigned inside a " +
    "callback. TypeScript only widens such a variable along straight-line code, " +
    "never across a function boundary. Annotate the declaration: " +
    "`let best: Match | null = null`.",
  TS2345:
    "If the parameter is `never`, this is a `const xs = []` being pushed to " +
    "inside a callback — the widening that would make it `string[]` does not " +
    "cross a function boundary. Annotate the declaration: " +
    "`const items: string[] = []`.",
  TS2740:
    "A function annotated with a success shape is also returning an error " +
    "object. Widen the return type to a union (`Promise<Info | { error: string }>`) " +
    "or drop the annotation and let it infer.",
  TS18046:
    "This value is `unknown`. If it came from `JSON.parse` or a `fetch` body, " +
    "annotate it at the boundary (`const data = (await res.json()) as Quote`) " +
    "rather than casting at every use.",
  TS7006: "Annotate the callback parameter, e.g. `(sum: number, item: Item) => ...`.",
  TS2304: "The name is not imported. Add the import; a TYPE needs `import type` here.",
  TS1361:
    "This is a type being used as a value. Import it with `import type` and " +
    "use it only in type positions.",
  TS2880:
    'Import attributes replaced import assertions: use `with { type: "json" }`, not `assert`.',
  TS1005:
    "A syntax error usually means an edit landed mid-expression. Read the file " +
    "around this line before editing again — do not patch blind.",
  TS2353:
    "This property is not part of the `agent()` config. Check the framework " +
    "reference for the field list rather than inventing one.",
};

/** Codes where naming the module's real exports is the whole fix. */
const EXPORT_CODES = new Set(["TS2305", "TS2724"]);

/** At or above this many instances of one code, advise a single-pass fix. */
const BATCH_THRESHOLD = 3;

const CODE_RE = /error (TS\d+):/g;
/** `Module '"@alexkroman1/aai"' has no exported member 'Foo'.` */
const MODULE_RE = /Module '"([^"]+)"' has no exported member|'"([^"]+)"' has no exported member/g;

/** Resolves a specifier's exported names; an empty array means "unknown". */
export type ExportResolver = (specifier: string) => readonly string[];

/**
 * A wrong import name is answerable exactly, so answer it rather than
 * hinting: the agent guessed, and the real list ends the guessing.
 */
function exportHints(output: string, resolveExports: ExportResolver): string[] {
  const out: string[] = [];
  for (const m of output.matchAll(MODULE_RE)) {
    const specifier = m[1] ?? m[2];
    if (!specifier) continue;
    const names = resolveExports(specifier);
    if (names.length > 0) out.push(`Exports of "${specifier}": ${[...names].sort().join(", ")}`);
  }
  return out;
}

/**
 * Append actionable hints to a failed typecheck's output.
 *
 * `resolveExports` is injected so the caller decides how a specifier is
 * resolved (and so this stays testable without a real node_modules).
 */
export function annotateDiagnostics(output: string, resolveExports?: ExportResolver): string {
  const all = [...output.matchAll(CODE_RE)].flatMap((m) => (m[1] ? [m[1]] : []));
  if (all.length === 0) return output;
  const counts = new Map<string, number>();
  for (const c of all) counts.set(c, (counts.get(c) ?? 0) + 1);
  const codes = new Set(all);

  const hints: string[] = [];
  for (const code of codes) {
    const hint = HINTS[code];
    if (hint === undefined) continue;
    const n = counts.get(code) ?? 1;
    // Repeated instances of ONE code are a single mistake made N times, and
    // fixing them one edit at a time costs a build cycle per pass. Observed:
    // fifteen TS7006 in one file repaired across three rounds.
    const batched =
      n >= BATCH_THRESHOLD
        ? ` There are ${n} of these — they are one mistake repeated, so fix ` +
          "them all in a single pass (rewrite the file if that is simpler) " +
          "rather than one edit and one rebuild at a time."
        : "";
    hints.push(`${code} (x${n}): ${hint}${batched}`);
  }

  if ([...codes].some((c) => EXPORT_CODES.has(c)) && resolveExports) {
    hints.push(...exportHints(output, resolveExports));
  }

  return hints.length === 0 ? output : `${output}\n\nHints:\n- ${hints.join("\n- ")}`;
}
