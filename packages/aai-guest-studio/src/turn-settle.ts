// Copyright 2026 the AAI authors. MIT license.
/**
 * Getting a turn's state back to the host: the end-of-turn settle and the
 * mid-turn workspace checkpoints. Split from studio/chat.ts, which owns the
 * agent loop and its HTTP surface; these two are about the guest→host RPCs
 * and the one distinction the host keys everything off — whether a sync is
 * TURN-COMPLETE.
 */

import { errorMessage } from "@alexkroman1/aai";
import { createCoalescingRunner } from "@alexkroman1/aai/internal";
import { hostRequest } from "aai-guest-core/rpc";
import type { StudioSession } from "aai-guest-core/types";
import type { UIMessage } from "ai";
import { snapshotWorkspace } from "./workspace-fs.ts";

/**
 * Deadline for the guest→host workspace-sync / chat-persist RPCs.
 *
 * Exported because `studio/chat.ts` fires the start-of-turn persist on the same
 * channel and had its own copy of the number under a byte-identical doc comment
 * — one concern, one deadline, and this is the module that owns those RPCs.
 */
export const SYNC_RPC_TIMEOUT_MS = 30_000;

/** How a sync reads the workspace — a seam so a spec can skip the real walk. */
type Snapshot = typeof snapshotWorkspace;

/**
 * Push the workspace and settled conversation back to the host's stores.
 *
 * `done: true` marks this sync as the TURN-COMPLETE one — the guest's analog
 * of opencode's `session.idle` / codex's `agent-turn-complete`. The host
 * keys auto preview deploys off it; mid-turn checkpoints (below) share the
 * RPC method but never carry the flag, so a half-finished workspace is never
 * preview-deployed.
 */
export async function settleTurn(
  session: StudioSession,
  messages: UIMessage[],
  snapshot: Snapshot = snapshotWorkspace,
  checkpoints: Pick<WorkspaceCheckpointer, "drained"> | null = null,
): Promise<void> {
  // The TURN-COMPLETE sync must be the LAST word on the tree: the host applies
  // syncs last-writer-wins and keys the preview deploy off this one. A
  // checkpoint whose walk started before the turn's final edit could otherwise
  // finish after this walk and land a stale tree on top of it — found by
  // `turn-settle-fuzz.test.ts`, whose shrunk ordering is pinned there.
  await checkpoints?.drained();
  const { files, warnings } = await snapshot(session.dir);
  for (const warning of warnings) console.error(`studio sync: ${warning}`);
  // Independent stores — no reason to pay two 30s worst cases in sequence.
  await Promise.all([
    hostRequest("studio/sync-workspace", { files, done: true }, SYNC_RPC_TIMEOUT_MS),
    hostRequest("studio/persist-chat", { messages }, SYNC_RPC_TIMEOUT_MS),
  ]);
}

/**
 * Tools whose success changes files on disk. `bash` is in the set because it
 * is a real shell — a redirect or `mv` is as much an edit as `write_file`.
 * Read-only tools are excluded so a turn that only searches and reads never
 * pays for a snapshot.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "bash",
  "add_dependency",
  "remove_dependency",
  "update_dependencies",
  "download_to_workspace",
  "use_template",
]);

/**
 * Mid-turn workspace checkpointing.
 *
 * `settleTurn` runs from `onFinish`, which a killed guest never reaches — so
 * before this, a sandbox that died mid-turn lost every edit the turn had
 * made, and the user reloaded to an empty project having watched the agent
 * write the file. Checkpointing after each mutating step caps that loss at
 * the step in flight.
 *
 * Snapshots are serialized rather than concurrent: two overlapping walks of
 * the same workspace can interleave into a torn tree, and the host applies
 * whichever lands last. Checkpoints requested while one is running coalesce
 * into ONE trailing sync (`createCoalescingRunner`) instead of queueing
 * without bound — the snapshot reads the tree as it stands, so a long tool
 * chain issues at most one extra sync after the current one, never a backlog.
 */
/**
 * Request a checkpoint (fire-and-forget), plus `drained()`: resolves once every
 * checkpoint requested so far has settled, whatever its outcome.
 */
export type WorkspaceCheckpointer = (() => void) & { drained(): Promise<void> };

export function createWorkspaceCheckpointer(
  session: StudioSession,
  snapshot: Snapshot = snapshotWorkspace,
): WorkspaceCheckpointer {
  const runner = createCoalescingRunner(async () => {
    const { files } = await snapshot(session.dir);
    await hostRequest("studio/sync-workspace", { files }, SYNC_RPC_TIMEOUT_MS);
  });
  let reported: Promise<void> | null = null;
  // The run the latest trigger joined — a trailing run settles after the one
  // it followed, so this is the last checkpoint anything has asked for.
  let latest: Promise<void> = Promise.resolve();

  const checkpoint = () => {
    const run = runner.trigger();
    // Coalesced triggers share one run promise — log each run's failure once.
    if (run === reported) return;
    reported = run;
    latest = run.catch((err: unknown) => {
      // Never fatal — a lost checkpoint costs recoverable work, while a
      // thrown one would kill a reply that is otherwise fine.
      console.error(`studio chat: workspace checkpoint failed: ${errorMessage(err)}`);
    });
  };
  const drained = async (): Promise<void> => {
    // Re-read after each wait: a trigger may have joined a later run meanwhile.
    for (let seen = latest; ; seen = latest) {
      await seen;
      if (seen === latest) return;
    }
  };
  return Object.assign(checkpoint, { drained });
}
