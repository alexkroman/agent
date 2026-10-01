// Copyright 2026 the AAI authors. MIT license.
/**
 * What the agent's reply SAYS, as it is produced: the stream-part handler that
 * turns model output into captions and TTS text, the code-initiated line
 * placements (`lines.ts`), and the dead-air cover. May import `heard/`,
 * `history/` and `turn/`.
 */

export type { InReplyLineFlags, LineReplyDeps } from "./lines.ts";
export { createLineReply, speakFixedLine } from "./lines.ts";
export type { StreamPart, StreamPartHandler } from "./stream-parts.ts";
export { createStreamPartHandler, llmErrorDetails, llmErrorSentence } from "./stream-parts.ts";
