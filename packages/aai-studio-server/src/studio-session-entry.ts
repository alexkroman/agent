// Copyright 2026 the AAI authors. MIT license.
/**
 * One replica's live studio session — the entry its sandbox map holds.
 *
 * Split from studio-session-broker.ts so the broker file is lifecycle logic
 * rather than lifecycle logic plus the shape it operates on. The comments here
 * carry the two invariants that are easy to break from a distance: the chat
 * token must not rotate per broker call, and the preview target is captured at
 * broker time rather than resolved later.
 */

import type { WarmHarness } from "aai-server/sandbox";
import type { PreviewTarget } from "./studio-preview.ts";

export type SessionEntry = {
  warm: WarmHarness;
  url: string;
  /** This entry's own (scope, project) — its key in the cross-replica registry. */
  scope: string;
  project: string;
  lastUsed: number;
  /**
   * The chat-surface bearer, minted ONCE for this sandbox and handed to every
   * caller that brokers this project.
   *
   * It must not rotate per broker call. The guest holds exactly one token
   * (`session.chatToken`), so re-minting on a re-init invalidates the token
   * every earlier caller is still holding — and overlapping brokers for one
   * project are routine (a second tab, another device, a reload racing an
   * in-flight one; the same set `sessionLock` exists for). The loser's next
   * chat turn then 401s on a surface where the only credential IS this token.
   * Rotating bought nothing for that: the token is already random, scoped to
   * one sandbox, and dies with it.
   */
  chatToken: string;
  /**
   * Where this session's auto preview deploys go — the public origin and
   * caller key captured at broker time. Absent when the session was brokered
   * without a `serverUrl` (tests, programmatic callers): then agent edits
   * sync without auto-previewing.
   */
  previewTarget?: PreviewTarget;
  /**
   * How many host-driven operations are running INSIDE this sandbox right now
   * — Publish and the auto preview deploy, both of which send one
   * `workspace/deploy` and wait (studio-session-publish.ts).
   *
   * The idle sweeper reads it, because `lastUsed` cannot answer the question
   * during a long call: a deploy touches only when it RETURNS, and its
   * deadline (`WORKSPACE_DEPLOY_TIMEOUT_MS`, 330s) deliberately exceeds the
   * idle window (`STUDIO_SESSION_IDLE_MS`, 300s). A 200s cold build started
   * at T+120s was therefore swept mid-build: the sandbox was terminated under
   * its own `aai deploy`, the whole build re-ran from scratch, and the
   * browser's chat URL was dead. Held by `LiveSession.hold` (the publisher's
   * view of this entry) rather than refreshed on a timer, so the sandbox is
   * protected for exactly as long as the work runs and not one tick longer.
   */
  inFlight: number;
  /** This claim's release on the `sessions` owned map (see `disposeEntry`). */
  release: () => boolean;
};
