// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { stripVTControlCharacters } from "node:util";

/**
 * Build failure carrying diagnostics formatted for the chat and the UI.
 *
 * Lives in its own module so the workspace materializer, the worker build,
 * and the client build can all throw it without importing each other.
 */
export class StudioBuildError extends Error {}

/**
 * Format a Vite/Rollup build failure for the chat and the UI — one
 * implementation for the worker and client builds.
 *
 * Diagnostics are scrubbed of the scratch-dir prefix and terminal colour
 * codes: the coding agent (and the user reading the chat) only knows the
 * workspace, so a path like `.studio-build/<uuid>/agent.ts` is noise it
 * might try to "fix".
 */
export function formatBuildFailure(err: unknown, label: string, dir: string): string {
  // Allowlist rejections are already the message we want to show.
  const cause = (err as { cause?: unknown })?.cause;
  if (err instanceof StudioBuildError) return err.message;
  if (cause instanceof StudioBuildError) return cause.message;

  const e = err as { message?: string; id?: string; loc?: { file?: string; line?: number } };
  const file = e?.loc?.file ?? e?.id;
  const where = file ? `${path.basename(file)}${e.loc?.line ? `:${e.loc.line}` : ""}: ` : "";
  return scrub(`${label}:\n${where}${e?.message ?? String(err)}`, dir);
}

/**
 * Strip scratch-dir paths and ANSI escape codes from a diagnostic.
 *
 * Rollup reports paths relative to `process.cwd()` while Vite's own errors
 * carry absolute ones, so both spellings of the scratch dir are removed.
 * ANSI/VT sequences go via `node:util`'s own stripper.
 */
function scrub(message: string, dir: string): string {
  const forms = [dir, path.relative(process.cwd(), dir)].filter(Boolean);
  let out = stripVTControlCharacters(message);
  for (const form of forms) {
    out = out.split(`${form}${path.sep}`).join("").split(form).join(".");
  }
  return out;
}
