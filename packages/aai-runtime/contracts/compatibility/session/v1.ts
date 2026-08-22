// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:session` epoch 1.
 *
 * See `../../../../aai/contracts/compatibility/agent/v3.ts` for what "frozen"
 * obliges and why the imports are relative.
 *
 * One live session, written from the two positions that actually hold a
 * {@link SessionCore}: the SOCKET below it and the TRANSPORT above it.
 *
 * - Below: bytes arrive on a {@link SessionWebSocket} and become
 *   `configure` / `onAudio` / `command` / `stop`. Nothing here parses audio —
 *   the binary frames are deliberately outside the event vocabulary.
 * - Above: a provider's frames become {@link TransportEventBody} values handed
 *   to `report`, which is the ONE way a transport says what it observed. There
 *   is no per-event method to call and no `on*` to register, and that is the
 *   point: an event the session records is an event a reader can replay.
 *
 * Then the two things a host keeps BESIDE the session — the retained
 * {@link SessionEventStream} a resume reads its conversation out of, and the
 * {@link StateSyncSession} record that decides whether a state push is worth
 * bytes.
 */

import type { ReadyConfig, SessionCommand } from "@alexkroman1/aai/protocol";

import type {
  SessionCore,
  SessionEventPage,
  SessionEventStream,
  SessionWebSocket,
  StateSyncSession,
  StoredSessionEvent,
  TransportEventBody,
  TransportEventType,
} from "../../../runtime-barrel.ts";

/** `WebSocket.OPEN`, spelled rather than imported — this is the wire's number. */
const OPEN = 1;

/**
 * Wire a socket to a session.
 *
 * `configure` goes first, at zero RTT, and the ordering is load-bearing rather
 * than tidy: a socket that has been open for seconds carrying nothing is a
 * wedged peer, not a slow one, and the browser client arms its handshake guard
 * on exactly that frame. Note it is an EVENT — `session.configured` — so it is
 * stamped and recorded like anything else, which is what a hand-written JSON
 * literal on the socket could never be.
 */
export function wireSocket(ws: SessionWebSocket, core: SessionCore, config: ReadyConfig): void {
  core.configure(config);

  ws.addEventListener("message", (event) => {
    const { data } = event;
    // Text frames are commands and take the other path; everything binary is
    // user audio, which is not a command and never enters the event vocabulary.
    if (typeof data === "string") return;
    if (data instanceof Uint8Array) core.onAudio(data);
    else if (data instanceof ArrayBuffer) core.onAudio(new Uint8Array(data));
  });

  // A SYNCHRONOUS listener that hands the promise off itself: `addEventListener`
  // discards what a listener returns, so an `async` one would surface a failed
  // stop as an unhandled rejection instead of a logged shutdown failure.
  ws.addEventListener("close", (event) => {
    void core.stop().catch((err: unknown) => console.error(`stop after ${event.code}`, err));
  });
}

/**
 * One client command, forwarded whole.
 *
 * The socket layer parses the frame and hands the command over rather than
 * switching on `type` to pick one of five methods named after the five
 * commands — and an unrecognised type is a no-op inside, for the same
 * forward-compatibility reason the protocol's parser tolerates one.
 */
export function forwardCommand(core: SessionCore, cmd: SessionCommand): void {
  core.command(cmd);
}

/**
 * Whether this socket can take another audio chunk.
 *
 * `bufferedAmount` is optional on the type so a minimal double stays
 * assignable, so a reader treats absence as "no opinion" and skips the guard
 * rather than assuming zero.
 */
export function canSendAudio(ws: SessionWebSocket, limitBytes: number): boolean {
  return ws.readyState === OPEN && (ws.bufferedAmount ?? 0) < limitBytes;
}

/**
 * What a transport reports upward, in the protocol's own vocabulary.
 *
 * `TransportEventBody` is the narrowed slice a transport may emit — twelve of
 * the session's event types, with the envelope left OFF, because `meta` is
 * minted once by the session's emitter. A transport that stamped its own would
 * mint a second id for an event the stream had already recorded under another.
 */
export function reportTranscript(core: SessionCore, text: string, committed: boolean): void {
  const event: TransportEventBody = committed
    ? { type: "user-transcript.committed", text }
    : { type: "user-transcript.updated", text };
  core.report(event);
}

/** A provider failure the session survives — hence `fatal: false`. */
export function reportSpeechFailure(core: SessionCore, message: string): void {
  core.report({ type: "error.reported", code: "tts", message, fatal: false });
}

/**
 * The two reports the session does NOT simply pass through, named as data.
 *
 * `tool.called` is EXECUTED in S2S mode — the tool step emits its own — and
 * `reply.completed` is the provider's claim rather than the turn's end, which
 * the session decides for itself once the audio is out.
 */
export const HANDLED_BY_THE_SESSION: ReadonlySet<TransportEventType> = new Set([
  "tool.called",
  "reply.completed",
]);

/**
 * A reply's audio, from the transport's side: announce the reply, push chunks,
 * and then report the boundary.
 *
 * `onReplyStarted` is not an event because the wire has no `reply.started`;
 * `audio.completed` is, and it is a turn BOUNDARY the pacer queues behind
 * pending audio — sent early it truncates the reply, because the client's
 * playback worklet reads it as "this is all there is".
 */
export function speakReply(core: SessionCore, replyId: string, chunks: Uint8Array[]): void {
  core.onReplyStarted(replyId);
  for (const chunk of chunks) core.onAudioChunk(chunk);
  core.report({ type: "audio.completed" });
}

/**
 * Speak about something the caller did not just ask for — a durable run that
 * finished minutes later, with the caller still on the line.
 *
 * It reports FALSE rather than throwing when the transport has no such verb or
 * the session is already stopped, because the caller is a background run: there
 * is nobody to raise to, and "this session cannot be spoken to" is exactly what
 * a notifier needs in order to stop trying.
 */
export function offerResult(core: SessionCore, summary: string): boolean {
  return core.announce(`Tell the caller: ${summary}`);
}

/**
 * Whether this session is actually able to hold a conversation.
 *
 * `faultCode` exists because "started" and "working" are different questions: a
 * provider that could not open at all reports a fatal error and lets the
 * transport start anyway, which once logged a `tts: missing API key` and
 * `Session ready` 400 ms apart — a session that could never speak, announced as
 * ready.
 */
export function isHealthy(core: SessionCore): boolean {
  return core.faultCode === undefined;
}

/**
 * Read a session's retained events back, from a position.
 *
 * A read is BOUNDED by the tail as it stood when the read arrived rather than
 * holding a socket open, so a reader re-opens from where it left off — which is
 * what `page.tail` is for. The index is the cursor and the only authoritative
 * one; `meta.id` is the ingestion key, stable across re-reads, and the two are
 * not interchangeable.
 */
export async function readTranscript(
  stream: SessionEventStream,
  sessionId: string,
  from: number,
): Promise<{ next: number; turns: string[] }> {
  const page: SessionEventPage = await stream.read(sessionId, from, 200);
  const turns: string[] = [];
  for (const event of page.events) {
    // Only the COMMITTED pair: an interim snapshot is a caption, and an
    // interrupted reply's last snapshot is not a record of anything.
    if (event.type === "user-transcript.committed") turns.push(`caller: ${event.text}`);
    else if (event.type === "agent-transcript.committed") turns.push(`agent: ${event.text}`);
  }
  return { next: page.tail, turns };
}

/**
 * Where the tail is now, and whether losing the process would cost anything.
 *
 * Recording is synchronous and persisting is BATCHED — at turn boundaries and
 * on stop — so a crash loses at most the events since the last flush. That is
 * the trade a voice session makes to keep a Postgres round trip out of a turn
 * with a one-second time-to-first-token budget; a caller that needs the record
 * on disk right now asks for it.
 */
export async function checkpoint(
  stream: SessionEventStream,
  sessionId: string,
): Promise<{ tail: number; durable: boolean }> {
  const tail = stream.tail(sessionId);
  if (stream.durable) await stream.flush(sessionId);
  return { tail, durable: stream.durable };
}

/**
 * The backend's own rows, as a state backend hands them back: an index and the
 * event's JSON, verbatim.
 *
 * Verbatim because the store is not a second copy of the protocol — re-parsing
 * and re-serializing an event would let the stored shape drift from the wire
 * shape — so a reader that only needs the position never pays to decode.
 */
export function highestStoredIndex(rows: readonly StoredSessionEvent[]): number {
  return rows.reduce((max, row) => (row.index > max ? row.index : max), -1);
}

/**
 * The per-session record the state-sync decision reads and writes.
 *
 * It lives beside the session's slot values, and holding it here rather than
 * keyed on a state object is what removed the sharp edge that arrangement had:
 * a resumed session inherited the same object and therefore the same record, so
 * a push aimed at the superseded socket counted as delivered to the new client.
 * A fresh client is stale by virtue of being new, which is a property of the
 * client and not of the state — which is why the caller can force a push.
 */
export function stateSyncSessionOver(values: ReadonlyMap<string, unknown>): StateSyncSession {
  let lastPushed: string | undefined;
  return {
    read: (key) => values.get(key),
    lastPush: () => lastPushed,
    recordPush: (json) => {
      lastPushed = json;
    },
  };
}
