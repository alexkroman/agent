// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio size limits, in their own dependency-free module — the single
 * home for the studio's workspace/chat caps. Kept import-free so any
 * consumer (schemas, the workspace store, the session broker) can load
 * them without dragging zod along. The workspace FILE caps are no longer
 * declared here: they belong to the shared workspace contract in the SDK and
 * are re-exported below, so the three sides that must agree on them read one
 * definition.
 */

/**
 * The workspace file caps — RE-EXPORTED from the SDK
 * (`@alexkroman1/aai/workspace-files`), which also owns the walk and skip
 * rules the CLI's push and the guest's sync share. Validation here has to
 * accept exactly what those two produce, so it reads the same constants
 * rather than restating them.
 */
export {
  MAX_WORKSPACE_FILE_BYTES as MAX_STUDIO_FILE_BYTES,
  MAX_WORKSPACE_FILES as MAX_STUDIO_FILES,
} from "@alexkroman1/aai/workspace-files";
/** Max total bytes across a workspace (guards the single-doc storage model). */
export const MAX_STUDIO_WORKSPACE_BYTES = 50_000_000;
/** Max messages accepted per chat turn (client resends full history). */
export const MAX_STUDIO_CHAT_MESSAGES = 80;
/**
 * Max serialized bytes for a single chat message. Sized so an assistant
 * message carrying a couple of full-file tool outputs still fits.
 */
export const MAX_STUDIO_MESSAGE_BYTES = 600_000;
/**
 * Steps one chat turn may take.
 *
 * Was 16, which the starter evals showed was the dominant cause of failure:
 * turns died mid-repair (build → read error → edit → build) with a broken
 * workspace, not because the agent was lost but because it ran out of room.
 * opencode allows ~1000 and summarizes as it approaches the context limit;
 * this is the same trade at a more conservative ceiling, paired with
 * compaction in the guest (studio-compaction.ts) so the extra steps are
 * actually reachable.
 *
 * A runaway turn is still bounded — by this cap, by each tool's own deadline,
 * and by the client's Stop button.
 */
export const MAX_CHAT_STEPS = 80;
