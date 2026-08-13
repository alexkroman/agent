// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:session` epoch 1.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * The live call as a custom client reads it: the snapshot's every field, the
 * two ways of subscribing to it (`useSession` for the whole thing,
 * `useSessionSelector` for one slice), and the core built directly for a client
 * that is not React at all.
 */

import {
  type AgentCustomEvent,
  type AgentState,
  type ChatMessage,
  createSessionCore,
  type Session,
  type SessionCore,
  type SessionCoreOptions,
  type SessionError,
  type SessionErrorCode,
  type SessionSnapshot,
  useSession,
  useSessionSelector,
  VOICE_CAPTURE_CONSTRAINTS,
  type VoiceSessionOptions,
  type WebSocketConstructor,
} from "../../../index.ts";

/** Every control a component drives the call with, plus the snapshot. */
export function Controls() {
  const session: Session = useSession();
  const state: AgentState = session.state;
  const error: SessionError | null = session.error;
  const code: SessionErrorCode | undefined = error?.code;
  const messages: ChatMessage[] = session.messages;
  const events: AgentCustomEvent[] = session.customEvents;

  return (
    <div>
      <span>{state}</span>
      <span>{code ?? "ok"}</span>
      <span>{messages.length + events.length}</span>
      <button type="button" onClick={() => session.toggle()}>
        toggle
      </button>
      <button type="button" onClick={() => session.start()}>
        start
      </button>
      <button type="button" onClick={() => session.cancel()}>
        cancel
      </button>
      <button type="button" onClick={() => session.reset()}>
        new conversation
      </button>
      <button type="button" onClick={() => session.resetState()}>
        clear
      </button>
      <button type="button" onClick={() => session.disconnect()}>
        hang up
      </button>
      <button type="button" onClick={() => session.end()}>
        end
      </button>
    </div>
  );
}

/** One slice, with the equality function that keeps a render off the wire. */
export function Caption() {
  const transcript = useSessionSelector(
    (snapshot: SessionSnapshot) => snapshot.agentTranscript ?? snapshot.userTranscript,
    (a, b) => a === b,
  );
  return <p>{transcript}</p>;
}

/**
 * A non-React client owns the core itself: options in, a snapshot subscription,
 * and a detach for when it is done reading.
 */
export function headless(WebSocketImpl: WebSocketConstructor): {
  core: SessionCore;
  detach: () => void;
} {
  const options: VoiceSessionOptions = {
    platformUrl: "https://agents.example.com/support",
    WebSocket: WebSocketImpl,
  };
  const coreOptions: SessionCoreOptions = options;
  const core = createSessionCore(coreOptions);
  const detach = core.subscribe(() => {
    const snapshot: SessionSnapshot = core.getSnapshot();
    if (snapshot.running && !snapshot.recording) core.start();
  });
  core.connect({ signal: AbortSignal.timeout(30_000) });
  return { core, detach };
}

/** A client opening its own microphone gets the same signal the built-ins do. */
export const capture: MediaTrackConstraints = VOICE_CAPTURE_CONSTRAINTS;
