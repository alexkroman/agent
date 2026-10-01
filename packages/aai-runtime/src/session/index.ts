// Copyright 2026 the AAI authors. MIT license.
/**
 * One session: the transport-neutral attach lifecycle (`attach.ts`) and its
 * socket adapter (`ws-handler.ts`, `ws-client-sink.ts`, `ws-frames.ts`, the
 * `ws-lifecycle.ts` phase machine), client pacing (`paced-client-sink.ts`,
 * `audio-pacer.ts`), the session core and its two dispatchers (`core.ts`,
 * `commands.ts`), the hook emitter, the event log and history replays, and the
 * one `SessionDirectory` every reach for a live session goes through. Outside
 * this directory, import from here; a name not re-exported here is private to it
 * (guard-invariants rule 37).
 */

export type { AttachedSession, AttachSessionOptions } from "./attach.ts";
export { attachSession } from "./attach.ts";
export { SessionRefusedError } from "./attach-end.ts";
export { UNPACED_AUDIO_LEAD_MS } from "./audio-pacer.ts";
export type { ClientHistoryDeps } from "./client-history.ts";
export {
  bindClientSession,
  loadClientHistory,
  publishClientTranscripts,
  readClientTranscript,
} from "./client-history.ts";
export {
  answeredGreeting,
  MAX_SESSION_GREETING_CHARS,
  resolveSessionContext,
  SESSION_CONTEXT_TIMEOUT_MS,
} from "./context.ts";
export type { ServerSession } from "./core.ts";
export { createSessionCore } from "./core.ts";
export type { SessionDirectory, SessionWiring } from "./directory.ts";
export { createSessionDirectory } from "./directory.ts";
export type { SessionEmitter, SessionEventHookDeps } from "./emitter.ts";
export { createSessionEmitter, hookDepsFor } from "./emitter.ts";
export { historyFromEvents, modelHistoryOf } from "./event-history.ts";
export type { SessionEventPage, SessionEventStream } from "./event-stream.ts";
export {
  createSessionEventStream,
  SESSION_EVENT_READ_LIMIT,
  stampSessionEvent,
} from "./event-stream.ts";
export { createPacedClientSink } from "./paced-client-sink.ts";
export type { ResumeFindings } from "./resume-found.ts";
export { composeSessionGreeting, createResumeFindings } from "./resume-found.ts";
export type { SpeechDirectory } from "./speech.ts";
export type { SessionWebSocket } from "./ws-frames.ts";
export { asSessionWebSocket } from "./ws-frames.ts";
export { safeSend, wireSessionSocket } from "./ws-handler.ts";
