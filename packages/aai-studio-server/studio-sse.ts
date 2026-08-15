// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared machinery of the studio's SSE event routes (studio-routes.ts):
 * the payload builder both the project GET and its event stream use, and
 * the stream lifecycle helper.
 */

import { createCoalescingRunner } from "@alexkroman1/aai/internal";
import { registerLiveStream } from "aai-server/live-streams";
import type { SSEStreamingApi } from "hono/streaming";
import { type ProjectKind, resolveProjectKind } from "./studio-project-kind.ts";
import {
  currentFilesHash,
  hasPreviewChanges,
  hasUnpublishedChanges,
  type StudioWorkspace,
} from "./studio-workspace.ts";

/** Keep intermediaries (the studio proxy included) from timing the stream out. */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * The project's client-facing state, as a NAMED shape.
 *
 * It was `Record<string, unknown>`, which is the wrong type for a payload two
 * external consumers parse: the studio client renders every field, and `aai
 * pull` reads `sourceHash` as its fast-forward token. A record says nothing
 * about either, so renaming a field is a compile-clean change here and a
 * runtime break there.
 *
 * The optional fields are `?: T | undefined` because they are built by
 * conditional spreads under `exactOptionalPropertyTypes` — the same reason
 * `WorkspaceStamp` spells them that way.
 */
export type ProjectPayload = {
  files: Record<string, string>;
  /**
   * The files' content hash — the fast-forward token `aai pull` records and
   * `aai push` sends back as `baseHash`. The files hash rather than the row
   * version: metadata stamps (preview/Publish) bump the version without
   * touching a file, and a pusher only cares whether the FILES moved.
   */
  sourceHash: string;
  kind: ProjectKind;
  deployedSlug?: string | undefined;
  /** Edits that have not been published (production staleness). */
  unpublished: boolean;
  previewSlug?: string | undefined;
  /** Version token the client keys the Preview iframe by. */
  previewVersion?: string | undefined;
  /** An edit has not reached the preview yet. */
  previewStale: boolean;
  /** CLI output of the last failed preview deploy, for the pane's banner. */
  previewError?: string | undefined;
};

/**
 * Build it: one builder for `GET /projects/:project` AND its SSE events
 * stream, so the pushed shape can never drift from the fetched one. Staleness
 * flags are computed here so the client never hashes files.
 */
export function projectPayload(workspace: StudioWorkspace): ProjectPayload {
  return {
    files: workspace.files,
    sourceHash: currentFilesHash(workspace),
    // Resolved rather than spread through: a project written before the
    // new-project switcher existed carries no `kind`, and the client should
    // read the same default the prompt composition does, not `undefined`.
    kind: resolveProjectKind(workspace.kind),
    ...(workspace.deployedSlug && { deployedSlug: workspace.deployedSlug }),
    unpublished: hasUnpublishedChanges(workspace),
    ...(workspace.previewSlug && { previewSlug: workspace.previewSlug }),
    ...(workspace.previewHash && { previewVersion: workspace.previewHash }),
    previewStale: hasPreviewChanges(workspace),
    ...(workspace.previewError && { previewError: workspace.previewError }),
  };
}

/** An SSE frame, or null to end the stream (the watched row vanished). */
export type Frame = { event: string; data: string } | null;

/**
 * One shared read per watched row, however many streams are watching it.
 *
 * Every frame is produced by re-reading the row (events are signals, never
 * payloads — see the module header of studio-events-routes.ts), and the row a
 * `project` frame re-reads is the WHOLE workspace document, file map included.
 * Per stream, that is right; per TAB it is waste, and tabs are exactly what
 * multiply: the same project open on a laptop and a phone, or two windows
 * side by side, each held a stream that answered the same change event with
 * its own full-document query. A burst — a turn's file sync, then the preview
 * stamp — multiplied again.
 *
 * The frames are identical by construction (a pure function of the row), so
 * sharing costs nothing in correctness and saves the serialization too.
 * `createCoalescingRunner` is the exact semantics needed: a trigger arriving
 * during a run cannot be answered by that run — it may predate the change —
 * so it gets ONE shared trailing read started after the current one settles.
 *
 * Entries are REFCOUNTED, not merely cached: this is a per-process map keyed
 * by project, and a studio serves unboundedly many over its life, so a
 * runner outliving its last stream is a leak of exactly the kind that never
 * looks like one.
 */
export type SharedReads = {
  /**
   * Join the reader for `key`, creating it from `read` if this is the first
   * caller. Later callers reuse the FIRST `read` — legitimate here because
   * the key fully determines it (scope + project, over the one store this
   * process has), and worth knowing before keying one on anything less.
   */
  acquire(key: string, read: () => Promise<Frame>): { trigger(): Promise<Frame>; release(): void };
  /** Live entry count — for tests asserting the refcount really drains. */
  size(): number;
};

export function createSharedReads(): SharedReads {
  const entries = new Map<string, { trigger(): Promise<Frame>; refs: number }>();
  return {
    acquire(key, read) {
      let entry = entries.get(key);
      if (!entry) {
        entry = { ...createCoalescingRunner(read), refs: 0 };
        entries.set(key, entry);
      }
      entry.refs += 1;
      const held = entry;
      let released = false;
      return {
        trigger: () => held.trigger(),
        release() {
          // Idempotent, and identity-checked on the way out: a stream's
          // cleanup runs once, but making it safe to run twice costs one
          // boolean and removes a whole class of "who released it" question.
          if (released) return;
          released = true;
          held.refs -= 1;
          if (held.refs === 0 && entries.get(key) === held) entries.delete(key);
        },
      };
    },
    size: () => entries.size,
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
  // Shutdown ends the stream through this instead of the process exit
  // destroying the socket mid-chunk — see aai-server/live-streams.ts.
  const unregister = registerLiveStream(finish);
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
      unregister();
      cleanup();
      clearInterval(heartbeat);
    }
  };
  return { write, push, wait };
}
