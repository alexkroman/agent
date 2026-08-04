// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio service's route context: the shared platform bindings plus the
 * two stores only the studio reads.
 *
 * `workspaces` and `chats` used to be required members of aai-server's own
 * `HonoEnv` and `OrchestratorOpts`, so the agent service's public options type
 * was coupled to the studio's data model — a studio store change was a
 * compile-time change to aai-server, and the agent-only service constructed
 * Postgres stores it never queried. Declaring them here instead makes the
 * split CLAUDE.md describes real at the type level: aai-server owns the
 * platform core, and studio-specific state is the studio's to carry.
 */

import type { ChatStore } from "aai-server/chat-store";
import type { HonoEnv } from "aai-server/context";
import type { PlatformEvents } from "aai-server/platform-events";
import type { WorkspaceStore } from "aai-server/workspace-store";

export type StudioHonoEnv = HonoEnv & {
  Bindings: HonoEnv["Bindings"] & {
    /** Studio project workspaces (Postgres in production, memory in dev/tests). */
    workspaces: WorkspaceStore;
    /** Studio project chat histories (Postgres in production, memory in dev/tests). */
    chats: ChatStore;
    /**
     * Workspace change notifications (Supabase Realtime in production) —
     * feeds the project events SSE route that replaced client polling.
     */
    events: PlatformEvents;
  };
};
