// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio size limits, in their own dependency-free module — the single
 * home for the studio's workspace/chat caps. Kept import-free so any
 * consumer (schemas, the workspace store, the session broker) can load
 * them without dragging zod along, and because `aai-guest/limits.ts`
 * deliberately mirrors the workspace caps by value (asserted against this
 * file's source in `aai-guest/limits.test.ts` rather than imported — the
 * guest harness bundles no host packages).
 */

/** Max files per studio project workspace. */
export const MAX_STUDIO_FILES = 100;
/** Max bytes for a single workspace file. */
export const MAX_STUDIO_FILE_BYTES = 256_000;
/** Max total bytes across a workspace (guards the single-doc storage model). */
export const MAX_STUDIO_WORKSPACE_BYTES = 50_000_000;
/** Max messages accepted per chat turn (client resends full history). */
export const MAX_STUDIO_CHAT_MESSAGES = 80;
/**
 * Max serialized bytes for a single chat message. Sized so an assistant
 * message carrying a couple of full-file tool outputs still fits.
 */
export const MAX_STUDIO_MESSAGE_BYTES = 600_000;
