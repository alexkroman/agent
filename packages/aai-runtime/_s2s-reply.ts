// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-reply state for the S2S link: audio/transcript accounting.
 *
 * `reply.audio` is ~95% of inbound traffic and is deliberately never logged,
 * which left the two ways a reply can come back wrong indistinguishable in the
 * logs: a reply that streamed audio but never sent `transcript.agent`, and a
 * reply that produced nothing at all, both appear as a bare `reply.started` →
 * `reply.done` pair with nothing in between. They present to the user as two
 * different bugs ("no text appeared" vs "the agent went silent") and have
 * different causes, so `reply.done` reports what the reply actually delivered
 * and names the anomaly outright.
 *
 * **`transcript.agent` does not arrive for a tool-call turn.** Measured against
 * the live service (2026-08-03) with a standalone WebSocket client, no SDK in
 * the path: neither the reply carrying `tool.call` nor the reply after
 * `tool.result` emits it, while every non-tool reply emits it with a matching
 * `reply_id`. Merely declaring tools changes nothing — calling one does. So an
 * agent with tools has no captions on the turns that use them, and there is no
 * client-side remedy: `transcript.agent` is the only event in the protocol
 * carrying agent text.
 *
 * The docs contradict each other on whether this is intended. The canonical
 * message-sequence page shows `transcript.agent` inside its `opt tool call`
 * branch and calls it "Per agent reply"; the execution-modes page's
 * `interactive` diagram shows neither tool-turn reply emitting it. The service
 * matches the latter.
 *
 * **`transcript.agent.delta` DOES arrive**, and it is how the tool-turn replies
 * above get text after all. This module used to assert the opposite — "zero
 * frames arrive even for a plain greeting reply" — and instruct against adding
 * an accumulator. Re-measured 2026-08-06 against the live service with a
 * standalone WebSocket client (`tau2-bench/scripts/vaapi_delta_probe.py`): a
 * bare greeting reply, the exact case named as producing none, emits one frame
 * per word with `start_ms`/`end_ms`. Over one 215s retail session, 511 frames
 * across 20 replies — and **5 of those 20 replies sent deltas and never a
 * final `transcript.agent`**, 116 words that were otherwise unrecoverable
 * ("Let me pull up those order details for you right now."). Those are the
 * tool-preamble turns.
 *
 * Two properties decide how they are used, and neither matches the docs'
 * description of "streaming ... useful for live captioning in sync with
 * playback":
 *
 * - **They arrive in a BATCH, not progressively.** Every delta for a reply
 *   lands within 0.000-0.031s. So they are word-timing metadata for a
 *   reply the service has already composed, not a caption feed.
 * - **They arrive BEFORE the final** `transcript.agent` — 0.4s to 7.7s earlier.
 *   So they are the earliest text available, which is why they are forwarded as
 *   a partial rather than held.
 *
 * The accumulated text is committed as the reply's transcript only when the
 * reply COMPLETED without a final. Never on an interrupted reply: the batch
 * covers the whole composed reply, while `transcript.agent` with
 * `interrupted: true` is trimmed to what was actually spoken, so committing the
 * accumulation would put words in history the caller never heard.
 */

/**
 * How much of the agent's reply text arrived over the wire. `delta` means no
 * final `transcript.agent` came, but the word deltas were accumulated into one.
 */
export type AgentTextKind = "final" | "delta" | "none";

/** Mutable per-reply tally. Reset by {@link resetReplyAudit} on reply.started. */
export type ReplyAudit = {
  audioChunks: number;
  audioBytes: number;
  sawFinal: boolean;
  sawToolCall: boolean;
  /** Words from `transcript.agent.delta`, joined in arrival order. */
  deltaText: string;
};

export function createReplyAudit(): ReplyAudit {
  return {
    audioChunks: 0,
    audioBytes: 0,
    sawFinal: false,
    sawToolCall: false,
    deltaText: "",
  };
}

export function resetReplyAudit(audit: ReplyAudit): void {
  audit.audioChunks = 0;
  audit.audioBytes = 0;
  audit.sawFinal = false;
  audit.sawToolCall = false;
  audit.deltaText = "";
}

export function countReplyAudio(audit: ReplyAudit, byteLength: number): void {
  audit.audioChunks += 1;
  audit.audioBytes += byteLength;
}

/**
 * Append one word delta, returning the reply's accumulated text.
 *
 * Deltas are whole words with punctuation attached (`"calling."`) and carry no
 * spacing of their own, so a single space joins them. An empty delta is ignored
 * rather than allowed to introduce a double space.
 */
export function appendReplyDelta(audit: ReplyAudit, delta: string): string {
  if (delta === "") return audit.deltaText;
  audit.deltaText = audit.deltaText === "" ? delta : `${audit.deltaText} ${delta}`;
  return audit.deltaText;
}

function agentTextKind(audit: ReplyAudit): AgentTextKind {
  if (audit.sawFinal) return "final";
  return audit.deltaText === "" ? "none" : "delta";
}

/** Log fields describing what the finished reply actually delivered. */
export function replyAuditFields(audit: ReplyAudit): {
  audioChunks: number;
  audioBytes: number;
  agentText: AgentTextKind;
} {
  return {
    audioChunks: audit.audioChunks,
    audioBytes: audit.audioBytes,
    agentText: agentTextKind(audit),
  };
}

/**
 * Name the anomaly in a finished reply, or `undefined` when it looks normal.
 *
 * Two shapes are deliberately not anomalies. A tool-call reply carries the call
 * and nothing else by design, so it legitimately has neither audio nor text. An
 * interrupted reply is expected to be partial — warning there would fire on
 * every barge-in, which is ordinary conversation.
 */
export function replyAnomaly(audit: ReplyAudit, status: string): string | undefined {
  if (status === "interrupted" || audit.sawToolCall) return;
  if (audit.audioChunks === 0) return "S2S reply completed with no audio";
  // A reply covered by deltas alone is NOT an anomaly — that is the ordinary
  // shape of a tool-preamble turn, and the text was recovered. It is still
  // distinguished in the log (`agentText: "delta"`) so the two cases stay
  // tellable apart from each other, which is the whole point of this audit.
  if (agentTextKind(audit) === "none") return "S2S reply delivered audio with no transcript";
}
