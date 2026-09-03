// Copyright 2026 the AAI authors. MIT license.
/**
 * THE slugifier: how a human-supplied name becomes a platform slug.
 *
 * `sdk/slug.ts` says what a slug may LOOK like (`VALID_SLUG_RE`, the reserved
 * set, the `-preview` suffix); this says how an arbitrary string is reduced to
 * that grammar. Three sides needed it and had three answers: the studio
 * slugified a typed project name and a prompt-derived base with
 * `@sindresorhus/slugify`, while `aai push`/`aai deploy` derived a project
 * name from the DIRECTORY with a hand-rolled `[^a-z0-9-_]` strip. So a
 * directory named `Café Ordering` became `caf-ordering` from the CLI and
 * `cafe-ordering` from the studio — the same human name, two projects,
 * depending only on which path created it.
 *
 * It lives in `host/` rather than beside the contract in `sdk/slug.ts`
 * deliberately. That module is dependency-free so the CLI can load it on
 * every invocation and every agent bundle can carry it; this one pulls the
 * transliteration tables, which nothing at run time should pay for. Nothing
 * on the SDK hot path may import it — the callers are the CLI, the platform
 * server, and the studio.
 *
 * @internal Not part of the published API surface — see the `./slugify`
 * subpath, which exists for the workspace packages rather than for SDK users.
 */

import slugifyLib from "@sindresorhus/slugify";

/**
 * Normalize a human-given name into the slug grammar, capped at `maxLen`.
 *
 * Delegated to `@sindresorhus/slugify` rather than a local regex so
 * non-ASCII transliterates properly ("Café Ordering" → `cafe-ordering`,
 * where a plain `[^a-z0-9]` strip produces `caf-ordering`), and
 * `decamelize: false` keeps "MyAgent" as one word: the name is an identifier
 * the user typed, not a symbol to prettify.
 *
 * **What it guarantees is the slug CHARACTER grammar, not `VALID_SLUG_RE`.**
 * Every result is empty or matches `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/`, is at
 * most `maxLen` long, and is unchanged by a second pass. What it does NOT
 * guarantee is the two-character FLOOR `VALID_SLUG_RE` also requires:
 * `slugifyName("b", 64)` is `"b"`, and so are `"日X"` -> `"x"` and
 * `slugifyName("ab cd", 1)` -> `"a"` — legal outputs the platform refuses.
 * `slugify.test.ts` states the guarantees as properties and pins those
 * outputs; the claim used to be the whole grammar, asserted over five
 * hand-picked names all five characters or longer, which is what let a
 * one-letter name sit outside it.
 *
 * So the length check is the CALLERS' boundary, and both callers already draw
 * it: `CreateProjectSchema` refines with "Project name must contain at least
 * two letters or numbers", and `projectNameFromDir` tests `VALID_SLUG_RE` and
 * answers `null`. Padding a one-character result would invent a name nobody
 * typed, and emptying it would conflate "one usable character" with "nothing
 * usable" — a distinction those two callers answer differently. It also could
 * not be done here: `projectBaseFromPrompt` uses this as a TOKENIZER (maxLen
 * 2000, output split on `-`), where a single-character word is a word.
 */
export function slugifyName(input: string, maxLen: number): string {
  return slugifyLib(input, { decamelize: false }).slice(0, maxLen).replace(/-+$/, "");
}
