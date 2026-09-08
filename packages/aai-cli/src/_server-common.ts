// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
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
