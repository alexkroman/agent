// Copyright 2026 the AAI authors. MIT license.
/**
 * Serializes studio workspace mutations per (scope, project).
 *
 * Every workspace write is a read-modify-write of the whole document
 * (`mutateWorkspace`), and writers genuinely race: the AI SDK executes
 * multiple tool calls from one assistant step concurrently, an editor PUT
 * can land mid chat turn, and deploy stamps metadata after multi-second
 * builds. Without serialization those local writers would burn the
 * versioned put's single conflict retry on each other.
 *
 * Module-level on purpose: chat tools, the file routes, and deploy all run
 * in the same server process against the same store, so one keyed mutex
 * covers every writer. Long builds must NOT hold the lock — only the
 * read-modify-write around them does.
 *
 * Kept alongside the store's optimistic versioning (`workspace-store.ts`)
 * rather than folded into it: `mutateWorkspace` retries a conflicted write
 * exactly once, which tolerates a single concurrent writer — enough for a
 * cross-replica race, but not for the several tool calls one AI SDK step
 * can fan out locally. The lock serializes those, so in-process races never
 * consume the retry.
 */

import { createKeyedLock, withLock } from "aai-server/platform-barrel";
import { projectKey } from "./studio-workspace.ts";

const workspaceLock = createKeyedLock();

/** Run `work` while holding this workspace's mutation lock. */
export function withWorkspaceLock<T>(
  scope: string,
  project: string,
  work: () => Promise<T>,
): Promise<T> {
  return withLock(workspaceLock, projectKey(scope, project), work);
}
