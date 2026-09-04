// Copyright 2026 the AAI authors. MIT license.
/**
 * Is there an ffmpeg to talk to?
 *
 * Its own module rather than a line in `ffmpeg.ts` because of who asks. The
 * `@alexkroman1/aai/ffmpeg` subpath is what a step imports —
 * convert, probe, classify a failure — and none of that is answered by a
 * version string. The caller here is an OPERATOR: a self-hosted server or a
 * dev-server preflight deciding whether to report "no ffmpeg on this machine"
 * up front instead of letting a workflow die mid-conversion. So it is on
 * `@alexkroman1/aai/host-internal` with the path env vars and the spawn
 * budgets it shares a reader with.
 */

import type { FfmpegRunOptions } from "./_ffmpeg-spawn.ts";
import { isFfmpegError } from "./_ffmpeg-spawn.ts";
import { runFfmpeg } from "./ffmpeg.ts";

/**
 * ffmpeg's version string, or `undefined` when there is no ffmpeg to ask.
 *
 * A preflight check for a step or a diagnostic that would rather report "no
 * ffmpeg here" than fail mid-conversion. Only a MISSING binary answers
 * `undefined`; a binary that is present and broken throws, because that is a
 * real failure and swallowing it would report the same thing as an absence.
 */
export async function ffmpegVersion(options: FfmpegRunOptions = {}): Promise<string | undefined> {
  try {
    const { stdout } = await runFfmpeg(["-hide_banner", "-version"], options);
    // A real ffmpeg's first line is `ffmpeg version N.N …`; the fallback is
    // there so a present-but-silent binary never reads as an ABSENT one, which
    // is the only distinction this function promises.
    const first = Buffer.from(stdout).toString("utf-8").split("\n")[0]?.trim();
    return first === undefined || first === "" ? "ffmpeg (version unreported)" : first;
  } catch (err) {
    if (isFfmpegError(err) && err.kind === "missing-binary") return undefined;
    throw err;
  }
}
