// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai secret put --local` / `delete --local` — edit the project's `.env`
 * rather than the platform's secrets.
 *
 * `.env` is what `aai dev` reads for `ctx.env` and what `aai publish` uploads,
 * so writing a credential there is the local half of `aai secret put`. Scripts
 * did it with a regex (`^NAME=.*$`, replace or append), which is right until
 * the value holds a `#`, a quote or a newline, or the name is `export`ed, or a
 * previous value spanned lines — then the file parses to something else. This
 * module is that edit, done against the parser that READS the file
 * (`node:util`'s `parseEnv`, the one `resolveServerEnv` uses), and its spec
 * round-trips every value it writes through that parser.
 *
 * - **Every other line is kept byte for byte**, comments and order included.
 * - **An existing assignment is replaced in place**, the LAST one when there
 *   are several (the one `parseEnv` honours), with any continuation lines of
 *   a multi-line quoted value; the others are left alone.
 * - **Only TOP-LEVEL assignments are matched** — a `KEY=` line inside another
 *   key's multi-line quoted value is that value's text, not an assignment.
 * - **A new key is appended.**
 * - **Every edit is checked by the parser**: unless the result parses to the
 *   old entries with exactly this one changed, the file is refused untouched.
 * - **A symlinked `.env` is refused**: the atomic rename would replace the
 *   link with a regular file holding a copy of its target.
 * - **The file keeps its mode**; a new one is created `0600`, since it exists
 *   to hold credentials.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { CliError } from "./_output.ts";
import { lstatOrNull, readTextIfPresent, writeFileAtomic } from "./_utils.ts";

/** A name `parseEnv` and a shell both accept. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Refuse a name that would not parse back as itself. */
export function assertEnvName(name: string): void {
  if (!ENV_NAME_RE.test(name)) {
    throw new CliError(
      "usage",
      `"${name}" is not a valid .env name.`,
      "Use letters, digits and underscores, not starting with a digit.",
    );
  }
}

/**
 * A value spelled so `parseEnv` reads it back unchanged: bare when it is
 * plain, else in the first quote it does not contain — `'…'` and `` `…` `` are
 * literal (newlines included), `"…"` last because it expands `\n`. A value
 * holding all three quotes is refused rather than mangled.
 */
export function formatEnvValue(value: string): string {
  // `parseEnv` deletes every `\r` before it parses, quoted or not, so no
  // spelling carries one — `a\r\nb` would come back `a\nb`.
  if (value.includes("\r")) {
    throw new CliError(
      "usage",
      "This value cannot be written to .env unchanged: it holds a carriage return (\\r), which .env parsing drops.",
      "Strip the \\r (e.g. a CRLF file's line endings), or encode the value (base64) and decode it in the agent.",
    );
  }
  if (/^[\w@%+=:,./~-]*$/.test(value)) return value;
  for (const quote of ["'", "`"]) {
    if (!value.includes(quote)) return `${quote}${value}${quote}`;
  }
  if (!(value.includes('"') || value.includes("\\") || value.includes("\n"))) {
    return `"${value}"`;
  }
  throw new CliError(
    "usage",
    "This value cannot be written to .env unchanged: it holds all three quote characters.",
    "Store it somewhere else, or encode it (base64) and decode it in the agent.",
  );
}

/** One TOP-LEVEL assignment: its key and the line range `[start, end)` it spans. */
type Assignment = { key: string; start: number; end: number };

const QUOTES = new Set(["'", '"', "`"]);

/**
 * Every top-level assignment in `lines`, found the way `parseEnv` walks the
 * file — so a line INSIDE another key's quoted multi-line value is never taken
 * for an assignment of its own.
 *
 * The rules mirrored (probed against Node 24's parser, which is C++ and has no
 * grammar to import): `\r` is ignored; blank, `#` and `=`-less lines are
 * skipped; `export ` is dropped from a key; a value opening with a quote runs
 * to the next occurrence of that quote ANYWHERE later in the file, and when
 * there is none it is just the rest of its own line (`A='abc` is the
 * four-character value `'abc`, not "everything below"). Whatever this gets
 * wrong is caught by {@link verifiedEdit}, which judges the edit by the parser.
 */
function scanAssignments(lines: readonly string[]): Assignment[] {
  const found: Assignment[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? "").replaceAll("\r", "").trimStart();
    const eq = line.indexOf("=");
    if (line === "" || line.startsWith("#") || eq === -1) {
      i++;
      continue;
    }
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    const rest = line.slice(eq + 1).trimStart();
    const quote = rest[0];
    let end = i + 1;
    if (quote !== undefined && QUOTES.has(quote) && !rest.includes(quote, 1)) {
      const close = lines.findIndex((l, j) => j > i && l.includes(quote));
      if (close !== -1) end = close + 1;
    }
    found.push({ key, start: i, end });
    i = end;
  }
  return found;
}

/** Parse `text` the way every reader of `.env` does. */
function parseDotenv(text: string): Record<string, string> {
  return parseEnv(text) as Record<string, string>;
}

/**
 * `edited`, but only if it parses to exactly `expected` — else the file is
 * refused, untouched.
 *
 * The tokenizer is a model of a parser this module cannot import, and a file
 * can be shaped so that no line edit means one thing: a stray quote that a
 * new value would close, a value that swallows the line below it. Judging
 * the RESULT by the real parser turns every such case into a refusal rather
 * than a silently different `.env` — the one copy of a local credential.
 */
function verifiedEdit(edited: string, expected: Record<string, string>, name: string): string {
  if (!isDeepStrictEqual(parseDotenv(edited), expected)) {
    throw new CliError(
      "dotenv_ambiguous",
      `Refusing to edit .env: changing ${name} would also change how other entries in it parse.`,
      "The file probably has an unclosed or stray quote. Fix it by hand (or edit the value there), " +
        "then run the command again.",
    );
  }
  return edited;
}

/** `text` with `name` set to `value`: replaced in place, or appended. */
export function upsertEnv(text: string, name: string, value: string): string {
  assertEnvName(name);
  const line = `${name}=${formatEnvValue(value)}`;
  const expected = { ...parseDotenv(text), [name]: value };
  const lines = text.split("\n");
  // The LAST one — the assignment `parseEnv` honours.
  const range = scanAssignments(lines).findLast((a) => a.key === name);
  if (range) {
    lines.splice(range.start, range.end - range.start, line);
    return verifiedEdit(lines.join("\n"), expected, name);
  }
  const body = text.replace(/\n*$/, "");
  return verifiedEdit(body === "" ? `${line}\n` : `${body}\n${line}\n`, expected, name);
}

/** `text` without its assignment of `name` (every one), and whether it had one. */
export function removeEnv(text: string, name: string): { text: string; removed: boolean } {
  assertEnvName(name);
  const lines = text.split("\n");
  const ranges = scanAssignments(lines).filter((a) => a.key === name);
  if (ranges.length === 0) return { text, removed: false };
  // Back to front, so each splice leaves the earlier ranges' indices valid.
  for (const range of ranges.toReversed()) lines.splice(range.start, range.end - range.start);
  const { [name]: _gone, ...expected } = parseDotenv(text);
  return { text: verifiedEdit(lines.join("\n"), expected, name), removed: true };
}

/** The `.env` a project's local secrets live in. */
export function localEnvPath(cwd: string): string {
  return path.join(cwd, ".env");
}

/**
 * The mode of the `.env` about to be rewritten — refusing a SYMLINK, since
 * `writeFileAtomic`'s rename replaces the link itself with a regular file
 * holding a copy of whatever it pointed at (`.env -> ~/.aws/credentials`
 * became a project file full of AWS keys). `undefined` when there is no file.
 */
async function editableMode(file: string): Promise<number | undefined> {
  const stat = await lstatOrNull(file);
  if (stat === null) return undefined;
  if (stat.isSymbolicLink()) {
    throw new CliError(
      "dotenv_symlink",
      `${file} is a symlink to ${await fs.readlink(file)}; \`aai secret --local\` will not edit it.`,
      "Edit the file it points to yourself, or replace the link with a regular .env.",
    );
  }
  return stat.mode & 0o777;
}

// Writes go through `writeFileAtomic` (temp file + rename), so a crash
// mid-write cannot leave a truncated `.env` — the file is the only copy of a
// local credential.

/** Set `name` in `<cwd>/.env`, creating the file (0600) if needed. */
export async function putLocalSecret(cwd: string, name: string, value: string): Promise<string> {
  const file = localEnvPath(cwd);
  const mode = await editableMode(file);
  const existing = mode === undefined ? undefined : await readTextIfPresent(file);
  await writeFileAtomic(file, upsertEnv(existing ?? "", name, value), { mode: mode ?? 0o600 });
  return file;
}

/** Remove `name` from `<cwd>/.env`; `false` when it was not there. */
export async function deleteLocalSecret(cwd: string, name: string): Promise<boolean> {
  const file = localEnvPath(cwd);
  const mode = await editableMode(file);
  const existing = mode === undefined ? undefined : await readTextIfPresent(file);
  if (existing === undefined) return false;
  const { text, removed } = removeEnv(existing, name);
  if (removed) await writeFileAtomic(file, text, { mode });
  return removed;
}
