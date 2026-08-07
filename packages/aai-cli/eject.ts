// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai eject` — retrofit the self-hosted entrypoint into an existing project.
 *
 * Every project scaffolded from this CLI version onwards already has
 * `server.mjs` and an `npm start` script: the scaffold ships them, so
 * self-hosting is the default rather than something to opt into. This command
 * exists for the projects that predate that — `aai init` before it, or a
 * workspace pulled from a studio that was created earlier — where the files
 * are simply missing.
 *
 * It COPIES from the scaffold rather than writing its own contents. Two
 * definitions of "the self-hosted entrypoint" would drift, and the one nobody
 * runs locally is the one that would rot; this way an ejected project is
 * byte-identical to a freshly scaffolded one.
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

type EjectData = {
  /** Absolute path of the entrypoint written. */
  file: string;
  /** True when an existing `server.mjs` was replaced (`--force`). */
  overwritten: boolean;
  /** True when `scripts.start` was added to package.json by this run. */
  addedStartScript: boolean;
};

type Manifest = {
  scripts?: Record<string, string>;
  [key: string]: unknown;
};

/**
 * Add `scripts.start` unless the project already declares one.
 *
 * An existing `start` is left alone even under `--force`: `--force` is about
 * replacing the entrypoint file, and silently rewriting the command a project
 * boots with is a different, larger act. The mismatch is reported instead, so
 * the choice stays the author's.
 */
async function ensureStartScript(cwd: string): Promise<boolean> {
  const manifestPath = path.join(cwd, "package.json");
  const manifest = (await readJson(manifestPath)) as Manifest | null;
  if (!manifest) {
    log.warn(
      `No package.json here — add "start": "${START_SCRIPT}" yourself to get \`npm start\`.`,
    );
    return false;
  }
  const existing = manifest.scripts?.start;
  if (existing === START_SCRIPT) return false;
  if (existing !== undefined) {
    log.warn(`Kept your existing "start" script (${existing}) — run \`node ${SERVER_ENTRY}\`.`);
    return false;
  }
  manifest.scripts = { ...manifest.scripts, start: START_SCRIPT };
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

  const addedStartScript = await ensureStartScript(cwd);

  log.success(`Wrote ${SERVER_ENTRY}${overwritten ? " (replaced)" : ""}`);
  if (await fileExists(path.join(cwd, "client.tsx"))) {
    // The entrypoint falls back to the default UI and says so at boot, but the
    // fix is a build the user has to run — surface it here too.
    log.info("This project has a custom UI: run `aai build` first so it is served.");
  }
  log.info("Next: npm start (PORT and HOST override the 127.0.0.1:3000 default)");

  return ok({ file: target, overwritten, addedStartScript });
}
