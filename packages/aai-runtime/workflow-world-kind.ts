// Copyright 2026 the AAI authors. MIT license.
/**
 * Which world a guest is configured for.
 *
 * Its own module because both halves of the split need it and neither should
 * import the other: `workflow-world.ts` decides the kind, and
 * `workflow-world-migrate.ts` acts on it. A type in one of them would make the
 * dependency point the wrong way for one of the two.
 */

/**
 * Which world this guest is configured for.
 *
 * @internal
 */
export type WorldKind = "postgres" | "local";
