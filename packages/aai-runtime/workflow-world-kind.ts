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
 * - `platform` — the DevKit's world with every backend replaced by HTTP calls to
 *   the platform (`workflow-platform-world.ts`). What a DEPLOYED guest gets, and it
 *   opens no database of its own for workflows.
 * - `postgres` — `@workflow/world-postgres` against a connection string this
 *   process was given. A self-hosted `createServer`, or `aai dev` with a
 *   `DATABASE_URL`.
 * - `local` — state in a directory, queue in memory. `aai dev` with no database,
 *   where a restart forgetting in-flight runs is the honest trade.
 *
 * @internal
 */
export type WorldKind = "platform" | "postgres" | "local";
