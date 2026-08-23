// Copyright 2026 the AAI authors. MIT license.
/**
 * A co-located spec, which is NOT a tool — `roll_die.spec` is not a name any
 * provider would accept, so the registry skips it rather than judging it.
 *
 * Named `.spec.ts` and not `.test.ts` deliberately: this package's vitest
 * `include` collects the latter, and a file collected as a suite would fail
 * the run for having no tests in it.
 */

export default { description: "not a tool", execute: () => null };
