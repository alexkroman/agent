// Copyright 2026 the AAI authors. MIT license.
/**
 * Writing into a directory the CLI does not own — a `--force` pull, an
 * `aai init` into a directory that already has things in it — without
 * writing THROUGH a symlink into somewhere else.
 *
 * Both commands decide where a file goes by joining a relative path onto a
 * target directory, and a lexical containment check (`isPathInside`) cannot
 * see what is on disk: `agent.ts -> ../outside/victim.txt`, a `tools/` that is
 * a link to another tree, or a DANGLING `.gitignore -> ~/x` (an existence
 * probe that reads through it sees ENOENT, and the write that follows creates
 * the link's target) all pass it. So every target is screened with `lstat`,
 * component by component, before anything is written, and the write itself
 * opens with `O_NOFOLLOW` so the last component cannot be swapped for a link
 * in between.
 */

import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./_output.ts";
import { lstatOrNull } from "./_utils.ts";

/**
 * Refuse `rel` under `root` when any EXISTING part of it is a symlink, or
 * when what exists disagrees with the shape the write needs (a file where a
 * parent directory must go, a directory where the file must go).
 *
 * `root` itself is not screened: it is the directory the user named, and a
 * symlinked project directory is an ordinary thing to have. Everything below
 * it is the write's own business. The walk stops at the first component that
 * does not exist — nothing below it can be a link yet.
 */
export async function refuseUnsafeTarget(root: string, rel: string): Promise<void> {
  const segments = rel.split(/[\\/]/).filter((s) => s !== "");
  let current = path.resolve(root);
  for (const [i, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (stat === null) return;
    const shown = path.relative(root, current);
    if (stat.isSymbolicLink()) {
      throw new CliError(
        "symlink_in_path",
        `Refusing to write ${rel}: ${shown} is a symlink, and writing through it would land outside ${root}.`,
        "Remove the link (or move it aside), or use a fresh directory.",
      );
    }
    // A parent must be a directory; the file itself must not be one.
    const isLast = i === segments.length - 1;
    if (stat.isDirectory() === isLast) {
      throw new CliError(
        "path_conflict",
        `Refusing to write ${rel}: ${shown} already exists as a ${isLast ? "directory" : "file"}.`,
        "Move it aside, or use a fresh directory.",
      );
    }
  }
}

/**
 * `O_NOFOLLOW` where the platform has one. Windows does not, and there a
 * symlink needs a privilege a project directory's author rarely holds; the
 * `lstat` screen above still runs.
 */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Write `content` at `abs`, creating parents, refusing to follow a symlink at
 * the file itself. `exclusive` refuses an existing file (EEXIST) instead of
 * replacing it; `mode` is the CREATE mode — what a fresh `.env` is born with.
 *
 * Call {@link refuseUnsafeTarget} first: this guards only the last component,
 * because `mkdir -p` and `open` both follow a link in a parent.
 */
export async function writeFileNoFollow(
  abs: string,
  content: string,
  opts: { exclusive?: boolean | undefined; mode?: number | undefined } = {},
): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    NOFOLLOW |
    (opts.exclusive ? constants.O_EXCL : constants.O_TRUNC);
  const handle = await open(abs, flags, opts.mode ?? 0o666);
  try {
    await handle.writeFile(content, "utf-8");
  } finally {
    await handle.close();
  }
}
