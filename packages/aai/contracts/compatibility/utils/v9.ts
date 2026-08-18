// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:utils` epoch 9.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * Epoch 9's change is `stepFetch`'s body: it takes an ASYNC ITERABLE as well as bytes
 * and a string. That is what lets a step hand a file it must not hold in memory to
 * another service — a stored upload read window by window — which is the only shape
 * in which a step can send a multi-gigabyte recording anywhere.
 */

import { readUpload, stepFetch, uploadInfo } from "../../../sdk/utils.ts";

/** How much of the stored upload one outbound window carries. */
const WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * The upload as a sequence of windows.
 *
 * A generator rather than one `readUpload`: each window is read, yielded, and
 * dropped, so nothing here holds more than `WINDOW_BYTES` at a time. `readUpload`
 * clamps to what is stored, so an empty window is the end of the file.
 */
async function* windows(id: string, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < size; at += WINDOW_BYTES) {
    const slice = await readUpload(id, { start: at, end: at + WINDOW_BYTES });
    if (slice.bytes.length === 0) return;
    yield slice.bytes;
  }
}

/**
 * Send a stored upload somewhere, without buffering it.
 *
 * The bytes form still compiles unchanged — see `sendSmallBody` below — which is what
 * "retained" means for this epoch: the iterable is an addition, not a replacement.
 */
export async function forwardRecording(id: string, to: string, key: string): Promise<string> {
  "use step";

  const stored = await uploadInfo(id);
  const res = await stepFetch(to, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/octet-stream" },
    body: windows(id, stored.size),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!res.ok) throw new Error(`Forward failed: HTTP ${res.status}`);
  const body = (await res.json()) as { url?: string };
  return body.url ?? "";
}

/** The two plain body shapes, which epoch 9 did not disturb. */
export async function sendSmallBody(to: string, bytes: Uint8Array): Promise<number> {
  "use step";

  const asBytes = await stepFetch(to, { method: "POST", body: bytes });
  const asJson = await stepFetch(to, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ size: bytes.length }),
  });
  return asBytes.status + asJson.status;
}
