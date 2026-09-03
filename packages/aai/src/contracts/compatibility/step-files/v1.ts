// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step-files` epoch 1.
 *
 * The round trip this capability exists for, written as a media step would have
 * written it: pull an upload down to a temp file, convert it, stream the result
 * back into the store, and return an upload id rather than a path. Written the
 * way it was authored at epoch 1, and it must keep compiling for as long as that
 * epoch is advertised as supported.
 *
 * The conversion itself is a PARAMETER. `@alexkroman1/aai/ffmpeg` is what a real
 * body would call there, and it is a different capability with its own epochs —
 * naming it here would let a break in that surface redden this file and
 * misattribute the finding to `step-files`. A frozen example is evidence about
 * ONE promise, so it names one capability's surface and takes the rest as
 * arguments.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Epoch 2 ADDED `STEP_FILE_READ_CONCURRENCY` and, with it, an optional
 * `concurrency` on `ReadUploadToFileOptions`. Both are additive: a name nobody
 * referenced cannot break anyone, and an optional field added to an options type
 * a body only ever CONSTRUCTS cannot either — {@link fetchWhole} below passes no
 * `concurrency` and still satisfies the wider type, because the field is
 * optional in the direction this file uses it.
 *
 * What is worth being precise about is that epoch 2 changed BEHAVIOUR under the
 * unchanged call. `readUploadToFile` with no `size` now reads its windows
 * concurrently, so {@link fetchWhole} — an epoch-1 body that names nothing new —
 * got faster on the day epoch 2 landed. That is a performance change and not a
 * semantic one: the file it writes and the count it answers with are the same,
 * because the fan-out path is only taken where `requireCompleteUpload` has
 * already established the file is whole. A body that could not accept the
 * change is one passing `size`, and that path stayed serial by construction —
 * see {@link drainStreamed}, which is why the option is what picks the walk
 * rather than a flag.
 *
 * **The direction that WOULD break this file is a signature or a CONTRACT.**
 * Every name below is invoked, so a narrowed parameter or a second required
 * argument reddens here. So would a quieter change: `readUploadToFile`
 * answering something other than the bytes that landed, or `writeUploadFromFile`
 * answering something without an `id`, both of which compile at the call and
 * break the step that reads the result.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 1 has to be dropped with a reason.
 */

import { join } from "node:path";
import {
  type ReadUploadToFileOptions,
  readUploadToFile,
  STEP_FILE_WINDOW_BYTES,
  type WithTempDirOptions,
  type WriteUploadFromFileOptions,
  withTempDir,
  writeUploadFromFile,
} from "../../../host/step-files.ts";

/**
 * ── EDIT: the name this pipeline leaves in `/tmp` while it runs. ─────────
 *
 * The directory is gone by the time anyone looks, so the prefix's real audience
 * is a person reading `ls /tmp` during a run that HUNG — which is exactly the
 * run where a directory called `aai-step-` tells them nothing.
 */
const TEMP: WithTempDirOptions = { prefix: "aai-normalize-" };

/**
 * How the converted file is stored.
 *
 * `type` is the field that is read: the byte route serves it as `Content-Type`,
 * so an upload stored without one is a file a browser downloads instead of
 * playing. `name` is read by nobody and is what a person sees on the download
 * link, which is reason enough.
 *
 * The window is spelled out rather than left to the default so the two legs of
 * this round trip move the same amount at a time — the read below names it too,
 * and a step whose halves disagree about it holds two different amounts of one
 * recording for no reason anybody wrote down.
 */
const STORED: WriteUploadFromFileOptions = {
  name: "normalized.wav",
  type: "audio/wav",
  windowBytes: STEP_FILE_WINDOW_BYTES,
};

/**
 * Materialize a FINISHED upload, and answer with what landed.
 *
 * No `size`, which is the whole of what this call says: the completeness
 * judgement stays with the SDK, so an upload that is still arriving is refused
 * here rather than silently copied as far as it has got. That refusal is the
 * point — the obvious thing to pass instead is `uploadInfo(id).size`, which IS
 * the contiguous prefix, so a body that "helpfully" supplies it transcodes a
 * truncated recording and nothing anywhere reports it.
 *
 * The returned count is not decoration. It is how a caller learns the store came
 * back short, and comparing it against nothing is how a hole becomes a plausible
 * wrong answer.
 */
export async function fetchWhole(uploadId: string, path: string): Promise<number> {
  const landed = await readUploadToFile(uploadId, path, {
    windowBytes: STEP_FILE_WINDOW_BYTES,
  });
  if (landed === 0) throw new Error(`Upload ${uploadId} is empty.`);
  return landed;
}

/**
 * Materialize an upload the CALLER is watching arrive.
 *
 * Passing `size` moves the completeness judgement to this body, which is what
 * makes a polling step expressible at all: the caller has read the record, has
 * seen `complete` for itself, and is asking for the bytes it knows are there.
 *
 * It is also the reason the count matters more here than above. A window may
 * come back short because the file really does end there, so the walk stops and
 * says how far it got — and a body that strode on by the window size instead
 * would leave a hole in the middle of a recording that reads as a decoder bug.
 *
 * @param size - What the caller's own read of the record said. Larger than what
 *   is stored is not an error: the read clamps, and the answer is the truth.
 */
export async function drainStreamed(
  uploadId: string,
  path: string,
  size: number,
): Promise<{ landed: number; short: boolean }> {
  const opts: ReadUploadToFileOptions = { size, windowBytes: STEP_FILE_WINDOW_BYTES };
  const landed = await readUploadToFile(uploadId, path, opts);
  return { landed, short: landed < size };
}

/**
 * The step: an upload in, a converted upload out, and no path in between.
 *
 * `withTempDir` is what makes that true. A step is journaled by its RETURN VALUE
 * and may be replayed in a different process, so a path in a return value names
 * a file that is gone by the time anything reads it — and the failure mode of
 * getting this wrong is not an error but a resumed run reading a directory
 * another run is using. Making the lifetime a lexical scope means the only thing
 * that can cross the boundary is the id.
 *
 * `convert` is handed two paths rather than bytes, which is the reason this
 * whole capability exists: an `.m4a` off a phone carries its index at the END of
 * the file, so a decoder reading it from a pipe cannot seek to it and fails
 * outright, and piped output is capped well below the two-hour recording these
 * pipelines are built for.
 */
export async function normalize(
  uploadId: string,
  convert: (source: string, target: string) => Promise<void>,
): Promise<{ id: string; bytes: number }> {
  return await withTempDir(async (dir) => {
    const source = join(dir, "source");
    const target = join(dir, "normalized.wav");
    const bytes = await fetchWhole(uploadId, source);
    await convert(source, target);
    const stored = await writeUploadFromFile(target, STORED);
    return { id: stored.id, bytes };
  }, TEMP);
}
