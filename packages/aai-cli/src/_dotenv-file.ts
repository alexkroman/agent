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
 * - **A new key is appended.**
 * - **The file keeps its mode**; a new one is created `0600`, since it exists
 *   to hold credentials.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CliError } from "./_output.ts";
import { errorCode } from "./_utils.ts";

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

/** The index range `[start, end)` of the line(s) assigning `name`, last one wins. */
function assignmentRange(lines: string[], name: string): [number, number] | undefined {
  const head = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`);
  let found: [number, number] | undefined;
  for (let i = 0; i < lines.length; i++) {
    const match = head.exec(lines[i] ?? "");
    if (!match) continue;
    const rest = match[1] ?? "";
    const quote = rest[0];
    let end = i + 1;
    // A quoted value that does not close on its own line continues to the
    // first line that closes it — `parseEnv`'s multi-line form.
    if ((quote === '"' || quote === "'" || quote === "`") && !rest.slice(1).includes(quote)) {
      while (end < lines.length && !(lines[end] ?? "").includes(quote)) end++;
      end = Math.min(end + 1, lines.length);
    }
    found = [i, end];
    i = end - 1;
  }
  return found;
}

/** `text` with `name` set to `value`: replaced in place, or appended. */
export function upsertEnv(text: string, name: string, value: string): string {
  assertEnvName(name);
  const line = `${name}=${formatEnvValue(value)}`;
  const lines = text.split("\n");
  const range = assignmentRange(lines, name);
  if (range) {
    lines.splice(range[0], range[1] - range[0], line);
    return lines.join("\n");
  }
  const body = text.replace(/\n*$/, "");
  return body === "" ? `${line}\n` : `${body}\n${line}\n`;
}

/** `text` without its assignment of `name` (every one), and whether it had one. */
export function removeEnv(text: string, name: string): { text: string; removed: boolean } {
  assertEnvName(name);
  const lines = text.split("\n");
  let removed = false;
  for (let range = assignmentRange(lines, name); range; range = assignmentRange(lines, name)) {
    lines.splice(range[0], range[1] - range[0]);
    removed = true;
  }
  return { text: lines.join("\n"), removed };
}

/** The `.env` a project's local secrets live in. */
export function localEnvPath(cwd: string): string {
  return path.join(cwd, ".env");
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Write through a temp file and a rename, so a crash mid-write cannot leave a
 * truncated `.env` — the file is the only copy of a local credential.
 */
async function writeKeepingMode(file: string, text: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, { mode });
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, file);
}

/** Set `name` in `<cwd>/.env`, creating the file (0600) if needed. */
export async function putLocalSecret(cwd: string, name: string, value: string): Promise<string> {
  const file = localEnvPath(cwd);
  const existing = await readIfPresent(file);
  const mode = existing === undefined ? 0o600 : (await fs.stat(file)).mode & 0o777;
  await writeKeepingMode(file, upsertEnv(existing ?? "", name, value), mode);
  return file;
}

/** Remove `name` from `<cwd>/.env`; `false` when it was not there. */
export async function deleteLocalSecret(cwd: string, name: string): Promise<boolean> {
  const file = localEnvPath(cwd);
  const existing = await readIfPresent(file);
  if (existing === undefined) return false;
  const { text, removed } = removeEnv(existing, name);
  if (removed) await writeKeepingMode(file, text, (await fs.stat(file)).mode & 0o777);
  return removed;
}
