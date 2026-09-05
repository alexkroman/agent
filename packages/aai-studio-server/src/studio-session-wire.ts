// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest→host half of a studio sandbox's control channel: what the coding
 * agent's guest may ask this replica to do at the end of a turn, and the
 * validation every one of those requests goes through.
 *
 * Split from the broker, which owns the sandbox LIFECYCLE (spawn, adopt,
 * evict). This owns the traffic that flows over a wired sandbox — a
 * different concern with a different failure mode: a rejected RPC here
 * costs a workspace sync, never a sandbox.
 *
 * Only the replica holding the control socket receives these. A peer that
 * adopted the session over HTTP (studio-session-fleet.ts) does not, which is
 * fine: both handlers write shared Postgres, so the owner doing the writing
 * is not a limitation — it is why adoption needs no ownership transfer.
 */

import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import { SafePathSchema } from "aai-server/config";
import type { WarmHarness } from "aai-server/sandbox";
import { GUEST_ROUTES, guestHttpUrl } from "aai-server/sandbox";
import type { ChatStore, WorkspaceStore } from "aai-server/stores";
import { z } from "zod";
import {
  DEFAULT_LOG_TOOL_LINES,
  MAX_LOG_TOOL_LINES,
  readProjectLogs,
} from "./studio-agent-logs.ts";
import type { PreviewTarget } from "./studio-preview.ts";
import { PROJECT_ENVIRONMENTS } from "./studio-project-slugs.ts";
import { MAX_STUDIO_CHAT_MESSAGES, UiMessageSchema } from "./studio-schemas.ts";
import { mutateWorkspace } from "./studio-workspace.ts";

/**
 * Guest-supplied workspace files. Wire-shape check only (record of safe
 * paths to strings): the size/count/total-byte limits are enforced by the
 * single authority a client file PUT also goes through —
 * `stampWorkspace`'s `assertWorkspaceLimits`, inside the `mutateWorkspace`
 * call below, whose throw rejects the RPC just the same.
 */
const GuestFilesSchema = z.object({
  files: z.record(SafePathSchema, z.string()),
  /**
   * True only on the TURN-COMPLETE sync (the guest's `settleTurn`, its
   * analog of opencode's `session.idle` / codex's `agent-turn-complete`).
   * Mid-turn checkpoints omit it, so preview deploys are keyed
   * deterministically to settled turns — never to a half-finished tree.
   */
  done: z.boolean().optional(),
});

// Guest-sent wire data: the settled conversation is validated per message
// (structure + content-size cap) before it lands in the chat store, not
// accepted as a blob of unknowns.
const GuestChatSchema = z.object({
  messages: z.array(UiMessageSchema).max(MAX_STUDIO_CHAT_MESSAGES),
});

/**
 * What the coding agent's `read_logs` tool may ask for.
 *
 * An ENVIRONMENT, never a slug — see "The guest never names a slug" in
 * studio-agent-logs.ts. `limit` is clamped there rather than here, because the
 * clamp is the tool's contract and the schema is the wire's.
 */
const GuestLogsSchema = z.object({
  environment: z.enum(PROJECT_ENVIRONMENTS).optional(),
  limit: z.number().int().min(1).max(MAX_LOG_TOOL_LINES).optional(),
});

export type GuestWiringDeps = {
  workspaces: WorkspaceStore;
  chats: ChatStore;
  /**
   * Mark this sandbox used — locally AND across the fleet. Called on every
   * guest RPC because an agent turn longer than the idle window is activity
   * no other replica can see, and an expired lease invites a peer to
   * cold-spawn a duplicate in the middle of it.
   *
   * Zero-arg, and both hooks are: the broker builds this object per WIRED
   * SANDBOX (see `wire`), closing over the harness, key, scope and project, so
   * every argument these used to declare was one the implementation ignored in
   * favour of the closure — a signature describing a lookup that does not
   * happen.
   */
  touch: () => void;
  /**
   * The preview target for this sandbox, or null when it should not
   * auto-deploy (brokered without a `serverUrl`, or the sandbox is no longer
   * the project's — checked at RPC time, not at wire time).
   */
  previewTarget: () => PreviewTarget | null;
  schedulePreview: (scope: string, project: string, target: PreviewTarget) => void;
};

/**
 * Wire the control channel for one project's sandbox.
 *
 * Takes no session KEY any more: the two hooks that used to be handed one
 * resolve it from their own closure (see `GuestWiringDeps.touch`), so the
 * parameter described a lookup this module never performed.
 */
export function wireGuest(
  deps: GuestWiringDeps,
  warm: WarmHarness,
  scope: string,
  project: string,
): void {
  // No db — trial tool runs report storage-not-enabled, same as before.
  warm.conn.onRequest("studio/sync-workspace", async (params) => {
    deps.touch();
    const parsed = GuestFilesSchema.safeParse(params);
    // Throwing rejects the RPC — the guest logs it; the turn still streams.
    if (!parsed.success) throw new Error(`Invalid workspace sync: ${errorMessage(parsed.error)}`);
    const doc = await mutateWorkspace(deps.workspaces, scope, project, (workspace) => ({
      ...workspace,
      files: parsed.data.files,
    }));
    if (!doc) throw new Error(`Project ${project} not found`);
    // The turn settled with edits — ship the workspace to the preview slug so
    // the Preview pane picks it up without a Publish. Only on the `done`
    // sync: mid-turn checkpoints would preview half-finished trees.
    // Fire-and-forget: the sync must settle now; the deploy stamps its
    // outcome later.
    const target = parsed.data.done ? deps.previewTarget() : null;
    if (target) deps.schedulePreview(scope, project, target);
    return { ok: true };
  });
  // The coding agent reading its own project's deployed output. It reuses the
  // preview target for the two things the read needs — the public origin and
  // the account key the project's agents were deployed with — which is also
  // what scopes it: no target means this sandbox is no longer the project's (or
  // was brokered without a server URL), and neither state may read anything.
  warm.conn.onRequest("studio/agent-logs", async (params) => {
    deps.touch();
    const parsed = GuestLogsSchema.safeParse(params);
    if (!parsed.success) throw new Error(`Invalid log read: ${errorMessage(parsed.error)}`);
    const target = deps.previewTarget();
    if (!target) throw new Error("This session cannot read the project's agent logs");
    return await readProjectLogs(
      { workspaces: deps.workspaces, scope, project, target },
      omitUndefined({
        environment: parsed.data.environment,
        limit: parsed.data.limit ?? DEFAULT_LOG_TOOL_LINES,
      }),
    );
  });
  warm.conn.onRequest("studio/persist-chat", async (params) => {
    deps.touch();
    const parsed = GuestChatSchema.safeParse(params);
    if (!parsed.success) throw new Error(`Invalid chat snapshot: ${errorMessage(parsed.error)}`);
    await deps.chats.putChat(scope, project, parsed.data.messages);
    return { ok: true };
  });
  warm.conn.listen();
}

/**
 * The guest's chat URL, derived from the origin the backend reported.
 *
 * This used to reverse-engineer `sessionUrl` — swap the scheme, overwrite the
 * pathname — to reach a surface this package was never handed. Deriving from
 * the origin means a guest route rename is one edit in `guest-routes.ts`
 * rather than two backends plus URL surgery in another package.
 */
export function chatUrlForGuest(guestOrigin: string): string {
  return guestHttpUrl(guestOrigin, GUEST_ROUTES.studioChat);
}
