// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-reply state for the S2S link: audio/transcript accounting, and assembly
 * of the word-at-a-time agent transcript stream.
 *
 * `reply.audio` is ~95% of inbound traffic and is deliberately never logged,
 * which left the two ways a reply can come back wrong indistinguishable in the
 * logs: a reply that streamed audio but never sent `transcript.agent`, and a
 * reply that produced nothing at all, both appear as a bare `reply.started` →
 * `reply.done` pair with nothing in between. Both occur against the live
 * service — tool-call follow-up replies have been observed delivering audio
 * with no transcript, contrary to the documented sequence — they present to the
 * user as two different bugs ("no text appeared" vs "the agent went silent"),
 * and they have different causes. So `reply.done` reports what the reply
 * actually delivered and names the anomaly outright.
 */

/** How much of the agent's reply text arrived over the wire. */
export type AgentTextKind = "final" | "delta-only" | "none";

/** Mutable per-reply tally. Reset by {@link resetReplyAudit} on reply.started. */
export type ReplyAudit = {
  audioChunks: number;
  audioBytes: number;
  sawDelta: boolean;
  sawFinal: boolean;
  sawToolCall: boolean;
};

export function createReplyAudit(): ReplyAudit {
  return { audioChunks: 0, audioBytes: 0, sawDelta: false, sawFinal: false, sawToolCall: false };
}

export function resetReplyAudit(audit: ReplyAudit): void {
  audit.audioChunks = 0;
  audit.audioBytes = 0;
  audit.sawDelta = false;
  audit.sawFinal = false;
  audit.sawToolCall = false;
}

export function countReplyAudio(audit: ReplyAudit, byteLength: number): void {
  audit.audioChunks += 1;
  audit.audioBytes += byteLength;
}

function agentTextKind(audit: ReplyAudit): AgentTextKind {
  if (audit.sawFinal) return "final";
  return audit.sawDelta ? "delta-only" : "none";
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

/**
 * Punctuation that attaches to the preceding word with no separator, so an
 * aligner emitting "Tokyo" then "." renders "Tokyo." and not "Tokyo .".
 * Includes the apostrophe so a split contraction ("It" + "'s") rejoins.
 */
const DELTA_ATTACH_CHARS = ".,!?;:)]}'\"…";

/**
 * Append one `transcript.agent.delta` payload to a reply's accumulated text.
 *
 * The protocol describes the payload as a "word (or token)", and the two differ
 * in exactly the way that matters here: a word carries no spacing of its own,
 * while a token usually arrives with its leading space. Inserting a separator
 * only when neither side already has one is correct for both, so this does not
 * depend on which of the two the service happens to send.
 */
export function appendAgentDelta(acc: string, delta: string): string {
  if (acc === "" || delta === "") return acc + delta;
  const first = delta[0] ?? "";
  const last = acc.at(-1) ?? "";
  if (/\s/.test(last) || /\s/.test(first)) return acc + delta;
  if (DELTA_ATTACH_CHARS.includes(first)) return acc + delta;
  return `${acc} ${delta}`;
}
