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
 * `transcript.agent.delta` is documented in the events reference but **is not
 * implemented** — zero frames arrive even for a plain greeting reply that does
 * send `transcript.agent`, and it appears nowhere on the canonical page. An
 * accumulator for it was added and removed again; do not re-add one on the
 * strength of the docs alone.
 */

/** How much of the agent's reply text arrived over the wire. */
export type AgentTextKind = "final" | "none";

/** Mutable per-reply tally. Reset by {@link resetReplyAudit} on reply.started. */
export type ReplyAudit = {
  audioChunks: number;
  audioBytes: number;
  sawFinal: boolean;
  sawToolCall: boolean;
};

export function createReplyAudit(): ReplyAudit {
  return { audioChunks: 0, audioBytes: 0, sawFinal: false, sawToolCall: false };
}

export function resetReplyAudit(audit: ReplyAudit): void {
  audit.audioChunks = 0;
  audit.audioBytes = 0;
  audit.sawFinal = false;
  audit.sawToolCall = false;
}

export function countReplyAudio(audit: ReplyAudit, byteLength: number): void {
  audit.audioChunks += 1;
  audit.audioBytes += byteLength;
}

function agentTextKind(audit: ReplyAudit): AgentTextKind {
  return audit.sawFinal ? "final" : "none";
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
  if (agentTextKind(audit) === "none") return "S2S reply delivered audio with no transcript";
}
