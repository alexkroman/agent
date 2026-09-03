// Copyright 2026 the AAI authors. MIT license.
/**
 * Getting a turn's state back to the host: the end-of-turn settle and the
 * mid-turn workspace checkpoints. Split from studio-chat.ts, which owns the
 * agent loop and its HTTP surface; these two are about the guest→host RPCs
 * and the one distinction the host keys everything off — whether a sync is
 * TURN-COMPLETE.
 */

import { errorMessage } from "@alexkroman1/aai";
import { createCoalescingRunner } from "@alexkroman1/aai/internal";
import type { UIMessage } from "ai";
import { hostRequest } from "./harness-rpc.ts";
import type { StudioSession } from "./studio-session.ts";
import { snapshotWorkspace } from "./studio-workspace-fs.ts";

/**
 * Deadline for the guest→host workspace-sync / chat-persist RPCs.
 *
 * Exported because `studio-chat.ts` fires the start-of-turn persist on the same
 * channel and had its own copy of the number under a byte-identical doc comment
 * — one concern, one deadline, and this is the module that owns those RPCs.
 */
export const SYNC_RPC_TIMEOUT_MS = 30_000;

/**
 * Push the workspace and settled conversation back to the host's stores.
 *
 * `done: true` marks this sync as the TURN-COMPLETE one — the guest's analog
 * of opencode's `session.idle` / codex's `agent-turn-complete`. The host
 * keys auto preview deploys off it; mid-turn checkpoints (below) share the
 * RPC method but never carry the flag, so a half-finished workspace is never
 * preview-deployed.
 */
export async function settleTurn(session: StudioSession, messages: UIMessage[]): Promise<void> {
  const { files, warnings } = await snapshotWorkspace(session.dir);
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
export function createWorkspaceCheckpointer(session: StudioSession): () => void {
  const runner = createCoalescingRunner(async () => {
    const { files } = await snapshotWorkspace(session.dir);
    await hostRequest("studio/sync-workspace", { files }, SYNC_RPC_TIMEOUT_MS);
  });
  let reported: Promise<void> | null = null;

  return () => {
    const run = runner.trigger();
    // Coalesced triggers share one run promise — log each run's failure once.
    if (run === reported) return;
    reported = run;
    run.catch((err: unknown) => {
      // Never fatal — a lost checkpoint costs recoverable work, while a
      // thrown one would kill a reply that is otherwise fine.
      console.error(`studio chat: workspace checkpoint failed: ${errorMessage(err)}`);
    });
  };
}
