// Copyright 2025 the AAI authors. MIT license.
/** Starter files for a fresh studio project. */

/**
 * A new project starts EMPTY.
 *
 * It used to ship a working dice-roller agent, which read as helpful and was
 * not: the coding agent's first turn went into reading and dismantling
 * someone else's agent before it could write the user's, and a starter test
 * asserting the dice tools had to be rewritten too. Starting from nothing
 * means the first turn is spent on the thing the user actually asked for.
 *
 * The project is not shapeless, though — `ensureProjectShape` in the guest
 * still supplies package.json, tsconfig.json, global.d.ts and vite.config.ts
 * when the session materializes, so the workspace is a real project the
 * moment the agent writes its first file.
 */
export function starterFiles(): Record<string, string> {
  return {};
}
