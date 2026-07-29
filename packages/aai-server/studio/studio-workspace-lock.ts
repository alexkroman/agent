// Copyright 2026 the AAI authors. MIT license.
/**
 * Serializes studio workspace mutations per `{scope}/{project}`.
 *
 * Every workspace write is a blind read-modify-write of the whole JSON doc
 * (`getWorkspace` → mutate copy → `putWorkspace`), and writers genuinely
 * race: the AI SDK executes multiple tool calls from one assistant step
 * concurrently, an editor PUT can land mid chat turn, and deploy stamps
 * metadata after multi-second builds. Without serialization the last
 * `putWorkspace` wins and every earlier concurrent change is silently lost.
 *
 * Module-level on purpose: chat tools, the file routes, and deploy all run
 * in the same server process against the same storage, so one keyed mutex
 * covers every writer. Long builds must NOT hold the lock — only the
 * read-modify-write around them does.
 */

import { createKeyedLock } from "../_keyed-lock.ts";

const workspaceLock = createKeyedLock();

/** Run `work` while holding this workspace's mutation lock. */
export async function withWorkspaceLock<T>(
  scope: string,
  project: string,
  work: () => Promise<T>,
): Promise<T> {
  const release = await workspaceLock(`${scope}/${project}`);
  try {
    return await work();
  } finally {
    release();
  }
}
