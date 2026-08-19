// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai eject` — retrofit the self-hosted entrypoint into an existing project.
 *
 * Every project scaffolded from this CLI version onwards already has
 * `server.mjs` and the `prestart`/`start` pair: the scaffold ships them, so
 * self-hosting is the default rather than something to opt into. This command
 * exists for the projects that predate that — `aai init` before it, or a
 * workspace pulled from a studio that was created earlier — where the files
 * are simply missing.
 *
 * It COPIES from the scaffold rather than writing its own contents. Two
 * definitions of "the self-hosted entrypoint" would drift, and the one nobody
 * runs locally is the one that would rot; this way an ejected project is
 * byte-identical to a freshly scaffolded one.
 *
 * The SCRIPTS are the exception it cannot copy, since a project's package.json
 * is its own — so `PRESTART_SCRIPT`/`START_SCRIPT` are written here and pinned
 * against the scaffold's manifest by `eject.test.ts`. Both matter: the
 * entrypoint boots the BUILT worker, so an ejected project with no `prestart`
 * exits at once naming the missing artifact.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CliError, type CommandResult, ok } from "./_output.ts";
import { scaffoldDir } from "./_templates.ts";
import { log } from "./_ui.ts";
import { errorMessage, fileExists, readJson, writeJson } from "./_utils.ts";

/** The file `npm start` runs. Named once — the scaffold ships it under this name. */
export const SERVER_ENTRY = "server.mjs";

/** The `scripts.start` value that runs {@link SERVER_ENTRY}. */
export const START_SCRIPT = `node ${SERVER_ENTRY}`;

/**
 * The `scripts.prestart` value, which npm runs before `start`.
 *
 * {@link SERVER_ENTRY} boots the BUILT worker (`.aai/worker.mjs`), because a
 * tool is discovered by the bundler enumerating `tools/` and an un-bundled
 * loader would serve an agent with no tools at all — so an entrypoint with no
 * build in front of it is not a working project. `--skip-tests` because this
 * runs on the way to serving traffic: `npm test` is where a suite belongs, and
 * a failing test must not be what stops a container from starting. The
 * typecheck stays, since the bundlers strip types unchecked and self-hosting
 * has no other gate.
 *
 * Kept in step with the scaffold's own `package.json`, which the two together
 * are the only definition of — `eject.test.ts` asserts they agree.
 */
export const PRESTART_SCRIPT = "aai build --skip-tests";

type EjectData = {
  /** Absolute path of the entrypoint written. */
  file: string;
  /** True when an existing `server.mjs` was replaced (`--force`). */
  overwritten: boolean;
  /**
   * True when this run wrote `scripts.prestart`/`scripts.start` into
   * package.json. Also true for a project ejected by an older CLI, whose
   * `start` is already correct and whose `prestart` is missing — the entrypoint
   * this run just wrote needs the build in front of it.
   */
  addedScripts: boolean;
};

type Manifest = {
  scripts?: Record<string, string>;
  [key: string]: unknown;
};

/**
 * Add `scripts.start` — and the `prestart` that builds what it boots — unless
 * the project already declares a `start` of its own.
 *
 * An existing `start` is left alone even under `--force`: `--force` is about
 * replacing the entrypoint file, and silently rewriting the command a project
 * boots with is a different, larger act. `prestart` is part of the same act
 * rather than a separate one, so it is written only alongside a `start` we
 * wrote — bolting a build onto someone else's start command changes what that
 * command does, which is precisely what the rule above refuses. The mismatch is
 * reported instead, naming both halves, so the choice stays the author's.
 */
async function ensureStartScript(cwd: string): Promise<boolean> {
  const manifestPath = path.join(cwd, "package.json");
  const manifest = (await readJson(manifestPath)) as Manifest | null;
  if (!manifest) {
    log.warn(
      `No package.json here — add "prestart": "${PRESTART_SCRIPT}" and ` +
        `"start": "${START_SCRIPT}" yourself to get \`npm start\`.`,
    );
    return false;
  }
  const existing = manifest.scripts?.start;
  if (existing === START_SCRIPT && manifest.scripts?.prestart === PRESTART_SCRIPT) return false;
  if (existing !== undefined && existing !== START_SCRIPT) {
    log.warn(
      `Kept your existing "start" script (${existing}) — run \`${PRESTART_SCRIPT}\` ` +
        `then \`${START_SCRIPT}\`.`,
    );
    return false;
  }
  manifest.scripts = { ...manifest.scripts, prestart: PRESTART_SCRIPT, start: START_SCRIPT };
  await writeJson(manifestPath, manifest);
  return true;
}

/**
 * A missing scaffold source means a broken install (or an `AAI_TEMPLATES_DIR`
 * pointed somewhere wrong), not anything the user did — so the message names
 * the file and where it was looked for.
 *
 * Built here and thrown by the caller, the shape `build.ts` uses for the same
 * reason: `useErrorCause` reads a `throw new Error` inside a `catch` as
 * dropping the cause, and cannot see that `CliError` takes its options fourth.
 */
function scaffoldMissingError(source: string, err: unknown): CliError {
  return new CliError(
    "scaffold_missing",
    `Could not read the scaffold's ${SERVER_ENTRY} at ${source}: ${errorMessage(err)}`,
    "Reinstall @alexkroman1/aai-cli.",
    { cause: err },
  );
}

export async function executeEject(opts: {
  cwd: string;
  force?: boolean | undefined;
}): Promise<CommandResult<EjectData>> {
  const { cwd, force } = opts;
  const target = path.join(cwd, SERVER_ENTRY);
  const overwritten = await fileExists(target);

  if (overwritten && !force) {
    throw new CliError(
      "server_exists",
      `${SERVER_ENTRY} already exists — this project can already be self-hosted.`,
      `Run \`npm start\`, or re-run with --force to replace it with the current scaffold's copy.`,
    );
  }

  const source = path.join(scaffoldDir(), SERVER_ENTRY);
  try {
    await fs.copyFile(source, target);
  } catch (err) {
    throw scaffoldMissingError(source, err);
  }

  const addedScripts = await ensureStartScript(cwd);

  log.success(`Wrote ${SERVER_ENTRY}${overwritten ? " (replaced)" : ""}`);
  log.info(
    `Next: npm start — it builds first (\`${PRESTART_SCRIPT}\`), then serves ` +
      "on 127.0.0.1:3000 (PORT and HOST override that)",
  );

  return ok({ file: target, overwritten, addedScripts });
}
