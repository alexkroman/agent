// Copyright 2026 the AAI authors. MIT license.
/**
 * Vocabulary the template suites share — this package's own, per the repo's
 * `test-helper-modules` convention (a spec reaches for the helper module beside
 * it rather than importing another package's).
 *
 * Both functions came from `aai-gates/_gate-support.ts` when the repo-gate
 * suites moved out. They are copied rather than imported across the new package
 * boundary deliberately: exporting a test helper as a public subpath so one
 * sibling can reach it is exactly the shape the `aai-server` exports map is
 * criticized for, and these two are vocabulary — a comparator and a
 * single-export reader — not logic that can drift into disagreeing.
 */

/**
 * Code-unit ordering, spelled out.
 *
 * A bare `.sort()` coerces and compares by UTF-16 code unit anyway, but saying
 * so is the repo's standing rule for anything a gate reads: an implicit
 * comparator is one refactor away from `localeCompare`, which answers to the
 * runtime's ICU default and would make a gate report a locale difference as a
 * change.
 */
export const byCodeUnit = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * The single export of a module namespace, or `undefined` when it has none.
 *
 * A template's `agent.ts`, `client.tsx` and each `tools/*.ts` are contracted to
 * carry exactly one default-ish export; reading it positionally is what lets a
 * spec assert on that export without knowing its name.
 */
export const sole = <T>(module: Record<string, T>): T | undefined => Object.values(module)[0];
