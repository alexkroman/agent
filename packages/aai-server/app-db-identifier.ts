// Copyright 2026 the AAI authors. MIT license.
/**
 * How one app slug becomes the identifier its database, its role, and every
 * DDL statement about them use — plus the shape assertion that makes
 * interpolating it safe.
 *
 * A leaf of its own so `app-database.ts` and `app-db-session-tables.ts` can
 * both reach it without a cycle: the split between those two is the database
 * versus the two tables inside it, and both sides name the same identifier.
 *
 * @module
 */

import { hash } from "node:crypto";

const IDENTIFIER_RE = /^app_[a-f0-9]{16}$/;

/** Deterministic database/role identifier for one app slug. */
export function appDbIdentifier(slug: string): string {
  return `app_${hash("sha256", slug).slice(0, 16)}`;
}

/**
 * Assert the derived-identifier shape before any DDL interpolation. The
 * identifier comes from a hex digest so this can only fail on a programming
 * error — but DDL cannot take bind parameters, so the assertion is the guard.
 */
export function assertIdentifier(id: string): string {
  if (!IDENTIFIER_RE.test(id)) throw new Error(`Invalid app db identifier: ${id}`);
  return id;
}
