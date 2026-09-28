// Copyright 2026 the AAI authors. MIT license.
/**
 * The hold line a network builtin speaks when its call is SLOW — and only
 * then.
 *
 * Declaring it is also what keeps the transport's generic dead-air phrase out
 * of the turn (`coveredThisTurn` in `aai-runtime`'s `tool-messages-runner.ts`).
 * Without a declaration the generic cover's 1.2s tool window fired on
 * ordinary lookups — on a home-speaker weather turn it went out at 2.3s, after
 * the call had returned, and played straight into the answer as "I'm checking
 * on this. It's 59 degrees…". A call that returns inside {@link
 * BUILTIN_COVER_AFTER_MS} now says nothing but its answer.
 *
 * A DELAYED rung rather than a START line: a start line speaks on every call,
 * which is the preamble again under another name.
 */

import type { ToolMessagesInput } from "../sdk/tool-messages.ts";

/**
 * When a builtin's hold line fires, from the call's start. A call issued at
 * the measured p50 of ~1.1s into the turn speaks at ~3.6s, ~5.2s in the
 * caller's frame at the default 1600ms endpointing — about where a caller
 * starts wondering whether the line is dead — while the lookups these tools
 * make usually return well inside it.
 */
export const BUILTIN_COVER_AFTER_MS = 2500;

/**
 * `messages` for a builtin: one delayed line. Declarative, never a request for
 * patience — filler goes out into an open microphone, and a question gets
 * answered (see `DEAD_AIR_COVER_PHRASES`).
 */
export function builtinCover(content: string): ToolMessagesInput {
  return { delayed: [{ afterMs: BUILTIN_COVER_AFTER_MS, content }] };
}
