// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { CliError } from "./_output.ts";
import { errorCode } from "./_utils.ts";

/**
 * One dotenv file's entries, or `{}` when it is not there.
 *
 * An ABSENT file is normal — `.env` is gitignored and a container usually ships
 * neither — while an UNREADABLE one is not: the agent would boot with no
 * secrets and fail later as an opaque provider auth error, so that one throws.
 */
async function readDotenv(file: string): Promise<Record<string, string>> {
  try {
    // Node's built-in dotenv-syntax parser (quotes, comments, multiline) —
    // replaced the `dotenv` package, whose only use was this one call.
    return parseEnv(await fs.readFile(file, "utf-8")) as Record<string, string>;
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
    return {};
  }
}

/**
 * The dotenv files a DEPLOYMENT reads, in precedence order.
 *
 * `.env.example` counts as a DECLARATION here and nowhere else, which is what
 * lets a container run with no `.env` at all: that file is committed, it names
 * the secrets the agent needs, and `docker run -e MY_API_KEY=...` supplies the
 * values — the shell always winning over a file entry, and a declared-but-empty
 * value being dropped rather than kept (see below). Without it a deployment
 * that ships no `.env` — which is every correctly-built image — resolves an
 * empty agent env and fails later as an opaque provider auth error.
 *
 * `aai dev` deliberately reads `.env` alone. There the developer HAS the file,
 * and treating the example as a declaration would surface a key they have not
 * filled in yet as one they have.
 */
/**
 * The one dotenv file that SHIPS — copied into a target's deployment artifact
 * (`RUNTIME_FILES` in `_vercel-output.ts`) because it declares which variables
 * become `ctx.env`.
 *
 * Named on its own because "what does the deployment declare" and "what can
 * this machine resolve" are different questions with different answers, and a
 * build that asks the second when it means the first cannot see the failure
 * `missingDeployEnv` exists to report: `.env` is present in a host's BUILD
 * workspace and absent from its RUNTIME, so a value read from there suppresses
 * a warning about a variable the deployed function will never see.
 */
export const DEPLOY_ENV_DECLARATION_FILE = ".env.example";

export const DEPLOY_ENV_FILES = [DEPLOY_ENV_DECLARATION_FILE, ".env"] as const;

/**
 * Build the `ctx.env` record that agent tools will see at runtime.
 *
 * Only variables explicitly declared in `.env` are included — matching
 * the platform sandbox behavior where `ctx.env`
 * contains only secrets set via `aai secret put`. This prevents agents
 * from accidentally depending on shell-level vars (PATH, HOME, etc.) that
 * won't exist in production.
 *
 * Values are resolved by merging the `.env` file with the current
 * environment — existing shell exports take precedence over `.env`
 * defaults, without mutating `process.env`.
 *
 * @param cwd - Project directory containing `.env` (optional).
 * @param baseEnv - Override the environment to read values from (tests only).
 * @param files - Which dotenv files to read, later entries winning over
 *   earlier. Defaults to `.env` alone; {@link DEPLOY_ENV_FILES} is what a
 *   DEPLOYMENT reads, and its own doc says why the two differ.
 */
export async function resolveServerEnv(
  cwd?: string,
  baseEnv?: Record<string, string | undefined>,
  files: readonly string[] = [".env"],
): Promise<Record<string, string>> {
  const fileEntries: Record<string, string> = {};
  const root = cwd;
  if (root !== undefined) {
    for (const file of files) {
      Object.assign(fileEntries, await readDotenv(path.join(root, file)));
    }
  }

  const source = baseEnv ?? process.env;

  // Only include explicitly-declared keys (not all of process.env).
  // Shell env takes precedence over .env file values.
  //
  // An EMPTY value is dropped, not kept. A declared-but-blank key is how
  // `.env.example` says "you need to set this" (`BRAVE_API_KEY=`), and `aai
  // init` copies that file straight to `.env` — so keeping it put `""` into
  // the agent env, where it does more damage than absence:
  // `withHostCredentialFallback` fills a provider credential only when the
  // name is `undefined` in the env it is given, and `""` is not undefined. So
  // a blank line defeated the host fallback silently and the provider
  // authenticated with the empty string instead of reporting the credential
  // as missing. The self-hosted boot has always dropped empties and says why;
  // this is the rest of the CLI catching up, and it is what lets `.env.example`
  // declare a key it has no value for.
  const env: Record<string, string> = {};
  for (const [key, fileVal] of Object.entries(fileEntries)) {
    const val = source[key] ?? fileVal;
    if (val !== undefined && val !== "") env[key] = val;
  }

  return env;
}

/**
 * The values WRITTEN in the project's dotenv `files` — never the shell's —
 * for a caller that UPLOADS them (`aai publish`'s secret sync).
 *
 * {@link resolveServerEnv}'s shell-wins rule is right for a process that runs
 * here and wrong for one that sends: there a repo's `.env` chooses the KEYS and
 * the shell supplies the VALUES, so a cloned project declaring `GITHUB_TOKEN=`
 * had the user's exported token stored as its agent's secret. Here the file is
 * the whole answer; empty values are dropped as there.
 *
 * A dotenv file that is a SYMLINK out of the project is refused, naming it:
 * `.env -> ~/.aws/credentials` is a committed link (git stores symlinks), and
 * following it uploaded the AWS keys. A link that stays inside the project
 * (`.env -> .env.production`) is fine.
 */
export async function readUploadableEnv(
  cwd: string,
  files: readonly string[] = [".env"],
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const file of files) {
    const full = path.join(cwd, file);
    await assertInsideProject(cwd, full);
    for (const [key, val] of Object.entries(await readDotenv(full))) {
      if (val === "") delete env[key];
      else env[key] = val;
    }
  }
  return env;
}

/** Refuse `file` when it is a symlink whose real path leaves `cwd`. */
async function assertInsideProject(cwd: string, file: string): Promise<void> {
  let isLink: boolean;
  try {
    isLink = (await fs.lstat(file)).isSymbolicLink();
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw err;
  }
  if (!isLink) return;
  const [root, real] = await Promise.all([
    fs.realpath(cwd),
    fs.realpath(file).catch((err: unknown) => {
      // A dangling link reads as absent, like a missing file.
      if (errorCode(err) === "ENOENT") return;
      throw err;
    }),
  ]);
  if (real === undefined) return;
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CliError(
      "unsafe_env_file",
      `${file} is a symlink to ${real}, outside the project — its contents will not be uploaded as secrets.`,
      "Replace the link with a regular .env holding only this agent's secrets.",
    );
  }
}

/**
 * Every variable name the dotenv `files` DECLARE, whether or not they carry a
 * value.
 *
 * The complement of {@link resolveServerEnv}, which returns the subset that
 * resolved to something non-empty. Subtracting one from the other is how a
 * build reports the variables a deployment declares and the host has no value
 * for — see `missingDeployEnv` in `build.ts`. A declared-but-blank key is the
 * `.env.example` idiom for "you need to set this" (`BRAVE_API_KEY=`), so the
 * names are exactly what a caller asking that question needs and `resolveServerEnv`
 * is exactly where they are dropped.
 *
 * SORTED, and that is a choice rather than the parser's output. Node's
 * `parseEnv` preserves declaration order for keys that carry a VALUE but
 * groups the blank ones and returns them alphabetically (`Z=\nY=\nX=` comes
 * back `X, Y, Z`) — and a declaration file is mostly blank keys by
 * construction, so its own order barely survives the parse. Sorting makes the
 * result one predictable thing instead of two, which matters because a warning
 * built from this is read by a human and diffed by a test.
 *
 * @param cwd - Project directory. `undefined` declares nothing, matching
 *   {@link resolveServerEnv}'s handling of the same argument.
 * @param files - Which dotenv files to read. {@link DEPLOY_ENV_FILES} is what a
 *   DEPLOYMENT declares.
 */
export async function declaredEnvNames(
  cwd: string | undefined,
  files: readonly string[] = [".env"],
): Promise<string[]> {
  if (cwd === undefined) return [];
  const names = new Set<string>();
  for (const file of files) {
    for (const key of Object.keys(await readDotenv(path.join(cwd, file)))) names.add(key);
  }
  return [...names].sort();
}
