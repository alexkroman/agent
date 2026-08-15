// Copyright 2026 the AAI authors. MIT license.
/**
 * The conversation, read back out of the session's own event stream.
 *
 * This is what replaced the client telling the server what it remembered. A
 * reconnecting browser used to push its `messages` array back in a `history`
 * frame, which made the CLIENT the authority on the agent's memory — it could
 * omit turns, truncate them, reorder them or invent them, and a client with
 * nothing to send (a second tab, a phone call resuming onto a replacement
 * sandbox, an operator reattaching) restored nothing at all.
 *
 * ## Two events, and only two
 *
 * `user-transcript.committed` and `agent-transcript.committed` are exactly the
 * events the session emits at the moments it appends to history, which is what
 * makes this a READ of the record rather than a second derivation of it. In
 * particular it must not read `agent-transcript.updated`: those are interim
 * snapshots, they legitimately shrink and differ mid-string (the dead-air filler
 * the caller hears is in them and not in the reply), and an INTERRUPTED reply's
 * last snapshot is not a record of anything — see "History records what was
 * HEARD" in the SDK guide.
 *
 * The consequence to know: an interrupted reply contributes NO assistant turn
 * here, where the live session's own truncation rule contributes the words the
 * caller is estimated to have heard, marked `[interrupted]`. So a resumed
 * conversation is slightly shorter than one that never dropped. That is the
 * cheap direction of the same trade the live rule makes — under-keeping costs a
 * little redundancy, over-keeping tells the model it delivered information the
 * caller never got.
 */

import { DEFAULT_MAX_HISTORY } from "../sdk/constants.ts";
import type { SessionEvent } from "../sdk/protocol.ts";
import type { Message } from "../sdk/types.ts";

/**
 * The conversation these events record, oldest first and capped like the live
 * session's own window.
 *
 * @internal
 */
export function messagesFromEvents(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
  for (const event of events) {
    if (event.type === "user-transcript.committed") {
      messages.push({ role: "user", content: event.text });
    } else if (event.type === "agent-transcript.committed") {
      messages.push({ role: "assistant", content: event.text });
    } else if (event.type === "session.reset") {
      // A reset DISCARDED the conversation, so everything before it is not this
      // conversation. Replaying across one would restore turns the caller
      // explicitly cleared — and the agent would answer as though they had not.
      messages.length = 0;
    }
  }
  // Trimmed at the FRONT, matching the live window (`DEFAULT_MAX_HISTORY`): a
  // resumed session must not come back holding more context than it could have
  // accumulated without dropping.
  if (messages.length > DEFAULT_MAX_HISTORY) {
    messages.splice(0, messages.length - DEFAULT_MAX_HISTORY);
  }
  return messages;
}
