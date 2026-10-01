// Copyright 2026 the AAI authors. MIT license.
/**
 * How much conversation a session REMEMBERS — a memory bound, in tokens, that
 * never decides what the model is sent.
 *
 * Two different questions used to share one answer, a 200-message cap, and it
 * answered neither well. What a request may SEND is a question about the
 * model's window, answered in tokens by `transports/pipeline-context-budget.ts`
 * (a `prepareStep` preparer, so it trims the request and never the record).
 * What a session may KEEP is a question about the host's memory over an
 * unbounded call. A message count predicts neither: two hundred ~106 KB tool
 * results is 21 MB of history and an order of magnitude past any window, while
 * two hundred spoken sentences is a few kilobytes and a fraction of one.
 *
 * So the record is bounded in tokens as well, and the bound is sized so that
 * it can NEVER reach into a request: {@link HISTORY_RETAIN_TOKENS} is a
 * multiple of `LARGEST_CONTEXT_TOKEN_BUDGET`, the most any model's request may
 * carry, and {@link evictBeyondRetention} only ever drops a front message when
 * what stays still costs at least that much. The request budget keeps a SUFFIX
 * of the history no larger than the model's budget, so a retained suffix at
 * least that large contains it whole: every request is exactly the one the
 * unbounded history would have produced. The record keeps everything a request
 * could want, and loses only what no request could have sent.
 *
 * ## The decision, with its numbers
 *
 * 2 x the largest budget is ~1.57M estimated tokens (~6 MB of text) per view
 * at worst — less, at worst, than the message cap allowed with large tool
 * results, and unreachable by an ordinary spoken call. The factor of two is
 * headroom, not correctness: one budget already suffices (the property in
 * `_history-retention.test.ts` draws limits up to the bound itself), and the
 * second keeps `ctx.messages` — which reads the record, not the request —
 * from losing context the moment a request first trims.
 *
 * The full EVENT LOG (`session-event-stream.ts`) stays the source of truth for
 * resume and is not bounded here; a resume reads it back through
 * `historyFromEvents`, which applies this same retention, so a resumed session
 * comes back holding what a live one would have.
 */

import type { Message } from "@alexkroman1/aai";
import { estimateTokenCount } from "tokenx";
import {
  LARGEST_CONTEXT_TOKEN_BUDGET,
  MESSAGE_TOKEN_OVERHEAD,
} from "./transports/pipeline-context-budget.ts";

/** How many of the largest request budget a session's record retains. */
export const HISTORY_RETAIN_FACTOR = 2;

/**
 * Estimated tokens of conversation a session retains, per view — see the
 * module doc for why it is this multiple of the largest request budget.
 */
export const HISTORY_RETAIN_TOKENS = HISTORY_RETAIN_FACTOR * LARGEST_CONTEXT_TOKEN_BUDGET;

/** Per-message estimates for the TEXT view, keyed by the message object. */
const estimates = new WeakMap<Message, number>();

/**
 * Estimated tokens for one conversation (`ctx.messages`) message, memoized.
 *
 * The same estimator and per-message framing charge the request budget uses for
 * a `ModelMessage` (`estimateMessageTokens`), over the text this view holds.
 */
export function estimateConversationTokens(message: Message): number {
  const cached = estimates.get(message);
  if (cached !== undefined) return cached;
  const estimate = estimateTokenCount(message.role + message.content) + MESSAGE_TOKEN_OVERHEAD;
  estimates.set(message, estimate);
  return estimate;
}

/**
 * Drop the OLDEST messages of `arr` in place while what remains still costs at
 * least `retain`, answering what came off the front (oldest first).
 *
 * - **Never below `retain`.** A front message goes only when the remainder
 *   without it is still at least `retain`, which is the property the module
 *   doc's "never reaches into a request" rests on.
 * - **`canLead` keeps a pair whole.** The LLM view holds tool-call/result
 *   PAIRS, and a cut that left a `tool` message at the front would hand the
 *   provider a result with nothing to answer. So a cut point is only ever a
 *   message `canLead` accepts, the messages it skips go with the cut, and the
 *   remainder is measured AFTER skipping them — healing a split pair can never
 *   take the record below `retain` either.
 * - **At least one message stays**, however large.
 */
export function evictBeyondRetention<T>(
  arr: T[],
  retain: number,
  estimate: (message: T) => number,
  canLead: (message: T) => boolean = () => true,
): T[] {
  let rest = 0;
  for (const message of arr) rest += estimate(message);
  if (rest <= retain) return [];
  let start = 0;
  for (;;) {
    const front = arr[start];
    if (front === undefined) break;
    let next = start + 1;
    let after = rest - estimate(front);
    for (let m = arr[next]; m !== undefined && !canLead(m); m = arr[next]) {
      after -= estimate(m);
      next++;
    }
    if (next >= arr.length || after < retain) break;
    start = next;
    rest = after;
  }
  return start === 0 ? [] : arr.splice(0, start);
}
