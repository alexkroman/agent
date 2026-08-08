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
 * The result can be empty (a name of nothing but punctuation reduces to
 * nothing) and is NOT checked against `VALID_SLUG_RE` — callers decide
 * whether an unusable name is a rejection or a fallback to a generated one.
 */
export function slugifyName(input: string, maxLen: number): string {
  return slugifyLib(input, { decamelize: false }).slice(0, maxLen).replace(/-+$/, "");
}
