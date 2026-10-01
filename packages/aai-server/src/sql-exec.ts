// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform's minimal SQL seam: what every Postgres-backed store takes
 * instead of a driver, so a unit spec can hand it a recorder and the service
 * config hands it the admin pool (`service-config.ts`).
 */

/** Minimal SQL executor: one parameterized statement, resolves with rows. */
export type SqlExec = (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
