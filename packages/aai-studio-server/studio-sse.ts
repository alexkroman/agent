// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared machinery of the studio's SSE event routes (studio-routes.ts):
 * the payload builder both the project GET and its event stream use, and
 * the stream lifecycle helper.
 */

import type { SSEStreamingApi } from "hono/streaming";
import {
  currentFilesHash,
  hasPreviewChanges,
  hasUnpublishedChanges,
  type StudioWorkspace,
} from "./studio-workspace.ts";

/** Keep intermediaries (the studio proxy included) from timing the stream out. */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * The project's client-facing state — files, deploy metadata, and the auto
 * preview deploy's state: slug + a version token the client keys the
 * Preview iframe by (changes on every successful preview), stale = an edit
 * hasn't reached the preview yet, and the last failed preview's CLI output
 * for the banner. One builder for `GET /projects/:project` AND its SSE
 * events stream, so the pushed shape can never drift from the fetched one.
 * Staleness flags are computed here so the client never hashes files.
 *
 * `sourceHash` is the files' content hash — the fast-forward token `aai
 * pull` records and `aai push` sends back as `baseHash`. The files hash
 * rather than the row version: metadata stamps (preview/Publish) bump the
 * version without touching a file, and a pusher only cares whether the
 * FILES moved under it.
 */
export function projectPayload(workspace: StudioWorkspace): Record<string, unknown> {
  return {
    files: workspace.files,
    sourceHash: currentFilesHash(workspace),
    ...(workspace.deployedSlug && { deployedSlug: workspace.deployedSlug }),
    unpublished: hasUnpublishedChanges(workspace),
    ...(workspace.previewSlug && { previewSlug: workspace.previewSlug }),
    ...(workspace.previewHash && { previewVersion: workspace.previewHash }),
    previewStale: hasPreviewChanges(workspace),
    ...(workspace.previewError && { previewError: workspace.previewError }),
  };
}

/**
 * Shared machinery of the event streams: a serialized, closed-aware writer
 * (change events can burst — a turn's file sync, then the preview stamp —
 * and interleaved re-reads could write an older snapshot after a newer
 * one), the keepalive heartbeat, and the hold-open-until-disconnect
 * lifecycle. `push` takes a producer that re-reads its row and returns the
 * frame to send — or null to end the stream (the watched thing vanished).
 */
export function createSsePusher(stream: SSEStreamingApi): {
  write(event: string, data: string): Promise<void>;
  push(produce: () => Promise<{ event: string; data: string } | null>): void;
  /** Hold open until disconnect (or a null push); then run `cleanup`. */
  wait(cleanup: () => void): Promise<void>;
} {
  let closed = false;
  const done = Promise.withResolvers<void>();
  const finish = (): void => {
    closed = true;
    done.resolve();
  };
  const write = (event: string, data: string): Promise<void> =>
    closed ? Promise.resolve() : stream.writeSSE({ event, data });
  let chain: Promise<void> = Promise.resolve();
  const push = (produce: () => Promise<{ event: string; data: string } | null>): void => {
    chain = chain
      .then(async () => {
        const frame = await produce();
        if (frame === null) {
          finish();
          return;
        }
        await write(frame.event, frame.data);
      })
      .catch(() => {
        // A failed write means the peer is gone; the abort handler cleans up.
      });
  };
  const heartbeat = setInterval(() => {
    if (!closed) void stream.writeSSE({ event: "ping", data: "" }).catch(() => undefined);
  }, SSE_HEARTBEAT_MS);
  stream.onAbort(finish);
  const wait = async (cleanup: () => void): Promise<void> => {
    try {
      await done.promise;
    } finally {
      cleanup();
      clearInterval(heartbeat);
    }
  };
  return { write, push, wait };
}
