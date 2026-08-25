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
    "If the type is `never`, see the empty-initializer note below. " +
    "Otherwise, if this is a value read out of an object literal map, the map needs " +
    "`Record<string, T>` with `T` declaring every field (optional ones as `field?: X`). " +
    "Without it the inferred type is a union of the entries and only fields common to all of them exist.",
  // The empty-initializer family.
  //
  // Get the RULE right here, because the first version of these hints did not
  // and it cost more than saying nothing. It blamed a function boundary, then a
  // configuration; both were wrong at some point and a hint whose explanation
  // does not match the compiler is worse than none — it is a confident wrong
  // lead. One starter chased use sites one at a time for sixteen type checks
  // and never built.
  //
  // The project runs `noImplicitAny` ON (see WORKSPACE_TSCONFIG), so TypeScript
  // DOES widen `const xs = []` and `let x = null` from later assignments — but
  // only along straight-line code in the same scope. An assignment that happens
  // inside a callback, or after the value has already been read, does not
  // participate, and the declaration keeps its `never[]` / `null` type. That is
  // the case these two hints are for.
  TS2322:
    "If the target type is `null`, the variable was declared `let x = null` " +
    "and first assigned somewhere the widening cannot see — inside a callback, " +
    "or after it was already read — so its type stayed exactly `null`. " +
    "Annotate the DECLARATION: `let best: Match | null = null`.",
  TS2345:
    "If the parameter type is `never`, an array was declared empty and first " +
    "pushed somewhere the widening cannot see — inside a callback, or after it " +
    "was already read — so it stayed `never[]`. Annotate the DECLARATION, not " +
    "the call — `const items: string[] = []`, or a type argument on the " +
    "useState call in a client. Fixing the push site instead leaves the " +
    "declaration wrong, and the next build reports the next push.",
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
  // An import of a package the project does not declare. This is the FIRST
  // symptom of reaching for a package rather than adding it, and it fires at
  // the typecheck gate, before the bundler ever reports the same thing less
  // clearly. `add_dependency` is the whole fix — it both installs the package
  // and records it in package.json, which is what makes it survive a page
  // refresh and a Publish (the workspace's node_modules does not).
  TS2307:
    "The module is not installed, or the project does not declare it. " +
    "Run add_dependency with the package name — do NOT hand-edit package.json " +
    "and do not write your own type declarations for it. " +
    "If it IS declared and still missing, npm_info will say whether the name and " +
    "version exist. For a relative import, this is a wrong path instead.",
  TS1361:
    "This is a type being used as a value. Import it with `import type` and " +
    "use it only in type positions.",
  TS2880:
    'Import attributes replaced import assertions: use `with { type: "json" }`, not `assert`.',
  TS1005:
    "A syntax error usually means an edit landed mid-expression. Read the file " +
    "around this line before editing again — do not patch blind.",
  TS2353:
    "This property does not exist on the config you passed it to. The error " +
    "text above lists the fields that DO exist — read that list rather than " +
    "guessing again. `tool()` takes exactly `description`, `parameters`, and " +
    "`execute`; there is no result schema, no name, and no output type.",
};

/** Codes where naming the module's real exports is the whole fix. */
const EXPORT_CODES = new Set(["TS2305", "TS2724"]);

/** At or above this many instances of one code, advise a single-pass fix. */
const BATCH_THRESHOLD = 3;

const CODE_RE = /error (TS\d+):/g;
/** `Module '"@alexkroman1/aai"' has no exported member 'Foo'.` */
const MODULE_RE = /Module '"([^"]+)"' has no exported member|'"([^"]+)"' has no exported member/g;

/**
 * Resolves a specifier's exported names; an empty array means "unknown".
 *
 * ASYNC, because the only implementation reads a `package.json` and a `.d.ts`
 * off disk and this whole path runs in the process that is also pacing live
 * voice audio — a synchronous read there stalls the event loop for every
 * session on the sandbox, not just the write being diagnosed.
 */
export type ExportResolver = (specifier: string) => Promise<readonly string[]>;

/**
 * A wrong import name is answerable exactly, so answer it rather than
 * hinting: the agent guessed, and the real list ends the guessing.
 */
async function exportHints(output: string, resolveExports: ExportResolver): Promise<string[]> {
  const specifiers = [...output.matchAll(MODULE_RE)].flatMap((m) => {
    const specifier = m[1] ?? m[2];
    return specifier ? [specifier] : [];
  });
  // One disk read per specifier, and they do not depend on each other — a
  // failed typecheck naming three modules should not pay for three in series.
  const resolved = await Promise.all(
    specifiers.map(async (specifier) => ({ specifier, names: await resolveExports(specifier) })),
  );
  return resolved
    .filter(({ names }) => names.length > 0)
    .map(({ specifier, names }) => `Exports of "${specifier}": ${[...names].sort().join(", ")}`);
}

/**
 * Append actionable hints to a failed typecheck's output.
 *
 * `resolveExports` is injected so the caller decides how a specifier is
 * resolved (and so this stays testable without a real node_modules).
 */
export async function annotateDiagnostics(
  output: string,
  resolveExports?: ExportResolver,
): Promise<string> {
  // One map, not a map plus a Set of its own keys — the Set was derivable from
  // the map, and reading the count back out of it needed a `?? 1` fallback that
  // could never fire. Counted straight off the matches, with no intermediate
  // array of every occurrence: only the tallies are ever read.
  const counts = new Map<string, number>();
  for (const m of output.matchAll(CODE_RE)) {
    const code = m[1];
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  if (counts.size === 0) return output;

  const hints: string[] = [];
  for (const [code, n] of counts) {
    const hint = HINTS[code];
    if (hint === undefined) continue;
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

  if (resolveExports && [...EXPORT_CODES].some((code) => counts.has(code))) {
    hints.push(...(await exportHints(output, resolveExports)));
  }

  return hints.length === 0 ? output : `${output}\n\nHints:\n- ${hints.join("\n- ")}`;
}
