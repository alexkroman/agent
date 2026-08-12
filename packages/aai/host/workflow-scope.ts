// Copyright 2026 the AAI authors. MIT license.
/**
 * The scope predicate every scoped read and mutation appends, as SQL plus its
 * parameter.
 *
 * `undefined` means NO FILTER, and that is deliberate rather than lax: the store
 * is not the guard. Three postures reach it and only the middle one filters — an
 * app that declared no identity (every run's scope is NULL, so a filter would
 * match nothing useful), an identified end user (filter to exactly them), and the
 * OPERATOR, whose credential is the `AAI_WORKFLOW_API_TOKEN` bearer and who has to
 * be able to read every run for `aai workflow runs` and the studio card to work at
 * all. Deciding WHICH of the three a request is belongs to the API, which is the
 * only layer that has seen the bearer and run `identify`; putting a
 * fail-closed default here instead would have made the operator read the
 * exception, and an exception is what gets forgotten.
 *
 * A scoped read deliberately does NOT match NULL rows. A run created before an app
 * added `identify` belongs to nobody, and handing it to whichever user asks first
 * is the leak this column exists to prevent.
 */
export function scopeClause(scope: string | undefined, param: number): string {
  return scope === undefined ? "" : ` and owner_scope = $${param}`;
}
