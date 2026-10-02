// Copyright 2025 the AAI authors. MIT license.

/**
 * Framework-agnostic voice session core.
 *
 * Manages WebSocket communication, audio capture/playback, and agent state
 * transitions using a subscribe/getSnapshot pattern compatible with React's
 * `useSyncExternalStore` and other external store consumers.
 *
 * Server→client message interpretation lives in `session/messages.ts`;
 * the public/internal type declarations live in `session/types.ts`.
 *
 * No dependency on React, Preact, or any UI framework.
 */

import { createEpoch, RESUME_ID_RE, WS_OPEN } from "@alexkroman1/aai/internal";
import type { SessionCommand } from "@alexkroman1/aai/protocol";
import { createSessionIdentity } from "../client-identity.ts";
import type { VoiceSessionOptions } from "../types.ts";
import { type AudioEffectsDeps, createAudioEffects } from "./audio-effects.ts";
import { createAudioPath } from "./audio-state.ts";
import { createConnection } from "./connection.ts";
import { createDialer } from "./dial.ts";
import { HANDSHAKE_ERROR } from "./handshake.ts";
import {
  CLEARED_SESSION_STATE,
  createMessageHandlers,
  type SessionConfigMessage,
} from "./messages.ts";
import { createMicSender } from "./mic.ts";
import { createPreConnectAudio } from "./preconnect.ts";
import { canReconnect, forceReconnect, reconnectPending } from "./reconnect.ts";
import { createSessionStateMachine } from "./state.ts";
import {
  type BrowserSession,
  bargeIn,
  type browserSessionBrand,
  type ConnState,
  type SessionSnapshot,
  STOPPED,
} from "./types.ts";
import { buildWsUrl } from "./url.ts";
import { createUserInput } from "./user-turn.ts";

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a framework-agnostic voice session core that connects to an AAI
 * server via WebSocket.
 *
 * Uses a subscribe/getSnapshot pattern for state management, compatible with
 * React's `useSyncExternalStore` and other external store integrations.
 *
 * Most clients never call this: `mountClient()` creates a core and installs it in
 * React context for the hooks. Reach for it directly when building a
 * non-React UI (or wiring the session into another framework's store).
 *
 * @example
 * ```ts
 * import { createBrowserSession, type SessionSnapshot } from "@alexkroman1/aai-ui";
 *
 * declare function render(snapshot: SessionSnapshot): void;
 *
 * const session = createBrowserSession({ platformUrl: "https://host/my-agent/" });
 * session.subscribe(() => render(session.getSnapshot()));
 * session.start();
 * ```
 *
 * @param options - Session configuration including the platform server URL.
 * @returns A {@link BrowserSession} handle for controlling the session.
 *
 * @public
 */
export function createBrowserSession(options: VoiceSessionOptions): BrowserSession {
  return createBrowserSessionWith(options, {});
}

/**
 * {@link createBrowserSession} with its audio bring-up injectable. Not on the
 * barrel: it is the seam a spec uses to hold an audio path open by hand rather
 * than replacing the audio module.
 *
 * @internal
 */
export function createBrowserSessionWith(
  options: VoiceSessionOptions,
  internals: Pick<AudioEffectsDeps, "openAudioPath">,
): BrowserSession {
  // ─── Internal state ─────────────────────────────────────────────────────

  let currentSnapshot: SessionSnapshot = {
    ...CLEARED_SESSION_STATE,
    state: "disconnected",
    contentVersion: 0,
    started: false,
    running: false,
    recording: false,
    micMuted: false,
    // The programmatic endpoint — the LONG-LIVING platform URL
    // (`wss://host/my-agent/websocket`), derived up front so UIs can show it
    // before connecting. Deliberately NOT the brokered sandbox tunnel URL the
    // session may actually connect to: that URL dies with the sandbox (idle
    // eviction, redeploy), while the platform endpoint is stable and upgrades
    // callers to the current sandbox endpoint itself.
    apiUrl: buildWsUrl(options.platformUrl).toString(),
  };

  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const sub of subscribers) sub();
  }

  /** Snapshot fields whose changes bump `contentVersion` (rendered conversation content). */
  const contentKeys = ["messages", "toolCalls", "userTranscript", "agentTranscript"] as const;

  /** Does `partial` leave this field exactly as it already is? */
  function isUnchanged(key: keyof SessionSnapshot, partial: Partial<SessionSnapshot>): boolean {
    return partial[key] === currentSnapshot[key];
  }

  /** `sendText(…, { connect: true })` waiting for a session — see `UserTurnDeps.queued`. */
  const queuedText: string[] = [];

  function updateState(partial: Partial<SessionSnapshot>): void {
    // Every way a session stops being meant to run passes through here.
    if (partial.running === false) queuedText.length = 0;
    // A write that changes no field still notified every consumer. Now that
    // the state machine answers "did anything move" (a declined transition
    // returns the position unchanged), the check lives here for every caller;
    // `session/messages.test.ts` pins both cases.
    if (Object.keys(partial).every((key) => isUnchanged(key as keyof SessionSnapshot, partial))) {
      return;
    }
    const contentChanged = contentKeys.some(
      (key) => key in partial && partial[key] !== currentSnapshot[key],
    );
    currentSnapshot = contentChanged
      ? { ...currentSnapshot, ...partial, contentVersion: currentSnapshot.contentVersion + 1 }
      : { ...currentSnapshot, ...partial };
    notify();
  }

  function getSnapshot(): SessionSnapshot {
    return currentSnapshot;
  }

  function subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  }

  // ─── Connection state ───────────────────────────────────────────────────

  /**
   * The session's `state` and `error`, as one fact rather than two fields
   * thirteen call sites wrote independently — see `session/state.ts`,
   * which carries the three shipped bugs that arrangement produced.
   */
  const agentState = createSessionStateMachine();

  const conn: ConnState = { ws: null, turn: createEpoch() };

  // The resume identity and the next attempt's address (`session/dial.ts`:
  // session id, its storage across a RELOAD, handshake flag, broker latch). Who
  // the client IS (`client: "auto"`, the tab's inbox holder) is
  // `client-identity.ts`; the dialer sends the id the identity reports.
  const identity = createSessionIdentity(options, () => dialer);
  const dialer = createDialer({ ...options, client: identity.clientId }, notify);

  function resetState(): void {
    updateState(CLEARED_SESSION_STATE);
  }

  /** The socket if it can carry a frame — a socket, not a boolean, so it narrows `conn.ws`. */
  function openSocket(): ConnState["ws"] {
    return conn.ws?.readyState === WS_OPEN ? conn.ws : null;
  }

  function sendJson(msg: SessionCommand): void {
    openSocket()?.send(JSON.stringify(msg));
  }

  // Backpressure and the caller's mute — see `session/mic.ts`.
  const mic = createMicSender({ conn, snapshot: () => currentSnapshot, updateState });

  // ─── Audio path ───────────────────────────────────────────────────────────

  /**
   * The microphone, the worklets and the buffer in front of them, as a
   * statechart — see `session/audio-state.ts`, which carries what the
   * in-flight latch, the generation epoch and the two pre-init fields on
   * `ConnState` cost. `session/audio-effects.ts` is the other half: every
   * frame and snapshot write the machine decides on but cannot make.
   */
  // The mic opened at `connect()`, taken over at `config` (`session/preconnect.ts`).
  const preConnect = createPreConnectAudio(options.preConnectAudio !== false);
  const audio = createAudioPath(
    createAudioEffects({
      conn,
      updateState,
      agentState,
      sendJson,
      mic,
      preConnect,
      openAudioPath: internals.openAudioPath,
    }),
  );

  // ─── Message handling ─────────────────────────────────────────────────────

  const { handleMessage } = createMessageHandlers({
    getSnapshot,
    updateState,
    conn,
    agentState,
    audio,
    retire: () => connection.retire(),
  });

  // ─── Connection management ──────────────────────────────────────────────

  /**
   * React to the server's `session.configured` frame: record it and set up the
   * session's audio path. **It no longer replays history, and that is the
   * point**: a reconnect used to push `messages` back, making the CLIENT the
   * authority on the agent's memory; the server restores the conversation from
   * its own event stream now, covering what a client cannot (a second tab, a
   * replacement sandbox, a reopened tab). The transcript on screen is untouched.
   */
  function onServerConfig(config: SessionConfigMessage): void {
    dialer.configured(config.sid);
    options.onSessionId?.(config.sid);
    flushQueued();
    // The audio path reports its own failures — see `session/audio-state.ts`.
    audio.start(config);
  }

  /**
   * The socket, the handshake deadline over it and the server's idle
   * retirement, as a statechart — see `session/connection.ts`. `release` is the
   * exit action of its `open` state, so every way a connection ends shares it.
   */
  const connection = createConnection({
    dial: () => {
      // Prefetches the audio modules and, unless opted out, opens the mic.
      preConnect.begin();
      const socket = dialer.open();
      socket.binaryType = "arraybuffer";
      conn.ws = socket;
      return socket;
    },
    release: (socket) => {
      preConnect.release();
      audio.teardown();
      // Also cancels any still-scheduled partysocket retry; close() on an
      // already-closed socket is a spec-level no-op.
      socket.close();
      conn.ws = null;
    },
    abandon: () => disconnect(),
    receive: handleMessage,
    opened: () => updateState(agentState.apply({ type: "SOCKET_OPEN" })),
    configured: onServerConfig,
    // A FATAL error is not retryable by construction. Without this the ladder
    // ran ~110s and 10 socket opens (10 broker calls that can boot a sandbox)
    // before the server's sentence landed; measured in
    // `session/reconnect.test.ts`.
    fatal: () => agentState.fatal(),
    retryPending: reconnectPending,
    canRedial: () => canReconnect(conn.ws),
    redial: () => {
      forceReconnect(conn.ws);
    },
    retrying: () => {
      // Stops (and releases) a pending bring-up; the server restores the
      // conversation itself on the next attempt.
      audio.teardown();
      updateState({ ...agentState.apply({ type: "CONNECT" }), recording: false });
    },
    closed: (failure) => {
      // A close behind an `error` phase KEEPS it, and a clean close anywhere
      // else retires a lingering non-fatal banner — the `error` state's own
      // `CLOSED` handler (`session/state.ts`). `failure` is the server's own
      // SENTENCE when it wrote one (`session/close.ts`), and `FAILED`, so not
      // fatal — see HANDSHAKE_ERROR for the same call.
      const closed =
        failure === null
          ? agentState.apply({ type: "CLOSED" })
          : agentState.apply({
              type: "FAILED",
              error: { code: "connection", message: failure, fatal: false },
            });
      updateState({ ...closed, ...STOPPED });
    },
    exhausted: () => {
      updateState({
        ...agentState.apply({ type: "FAILED", error: HANDSHAKE_ERROR }),
        ...STOPPED,
      });
    },
  });

  function connect(opts?: { signal?: AbortSignal }): void {
    // Abort listeners on an already-aborted signal never fire (DOM spec), so
    // honor the documented "aborted ⇒ disconnected" contract up front.
    if (opts?.signal?.aborted) {
      disconnect();
      return;
    }
    updateState(agentState.apply({ type: "CONNECT" }));
    // Tears the previous connection down and clears the previous one's idle
    // retirement, so THIS socket can auto-reconnect.
    connection.dial(opts?.signal);
  }

  function cancel(): void {
    // Only meaningful mid-session: called while disconnected/errored it would
    // fake a "listening" state with nobody on the other end.
    if (!openSocket()) return;
    // A client-side barge-in is a turn boundary exactly as the server's
    // `cancelled` frame is: the flush below settles the interrupted turn's
    // drain, whose continuation must not outlive the turn it belonged to.
    bargeIn(conn, audio);
    updateState(agentState.apply({ type: "LISTEN" }));
    sendJson({ type: "cancel" });
  }

  // Push-to-talk, typed turns, tool answers — see `session/user-turn.ts`.
  const { userTurn, sendText, flushQueued, sendToolResult } = createUserInput({
    snapshot: () => currentSnapshot,
    connected: () => openSocket() !== null,
    queued: queuedText,
    open: () => {
      if (!currentSnapshot.running) (currentSnapshot.started ? toggle : start)();
    },
    bargeIn: () => bargeIn(conn, audio),
    agentState,
    updateState,
    sendJson,
  });

  function reset(): void {
    bargeIn(conn, audio);
    if (openSocket()) {
      sendJson({ type: "reset" });
      return;
    }
    // No socket, so the `reset` frame above went nowhere and this redial is
    // what starts the new conversation. `end()` is the whole clear-and-forget:
    // it drops the resume identity, so `start()` redials without
    // `?sessionId=` — a resume rejoins the conversation in progress,
    // keeping the server's history and suppressing the greeting. `start()`
    // also leaves the session running, so the controls don't show "Resume".
    end();
    start();
  }

  function disconnect(): void {
    connection.hangUp();
    // `DISCONNECT` rather than `CLOSED`: it deliberately does NOT clear the
    // error, so the banner explaining why a session ended survives the hang-up
    // that follows it.
    updateState({ ...agentState.apply({ type: "DISCONNECT" }), ...STOPPED });
  }

  function start(): void {
    updateState({ started: true, running: true });
    connect();
  }

  function toggle(): void {
    if (currentSnapshot.running) {
      disconnect();
    } else {
      updateState({ running: true });
      connect();
    }
  }

  function end(): void {
    connection.hangUp();
    // A later start() must be a NEW session, not a resume: the next connect
    // carries no `?sessionId=` (fresh per-session tool state) and the greeting
    // plays again.
    dialer.forget();
    updateState({
      ...CLEARED_SESSION_STATE,
      ...agentState.apply({ type: "END" }),
      started: false,
      ...STOPPED,
    });
  }

  function restart(): void {
    end();
    start();
  }

  function resume(sessionId: string): void {
    if (!RESUME_ID_RE.test(sessionId)) {
      throw new RangeError(`resume: "${sessionId}" is not a session id (${RESUME_ID_RE})`);
    }
    end();
    dialer.adopt(sessionId);
    start();
  }

  // Built WITHOUT the seal and cast once: the brand is type-only (see
  // `browserSessionBrand`), so this is the one place a `BrowserSession` exists.
  const session: Omit<BrowserSession, typeof browserSessionBrand> = {
    getSnapshot,
    subscribe,
    connect,
    cancel,
    userTurn: Object.freeze(userTurn),
    identity,
    sendText,
    sendToolResult,
    setMicMuted: mic.setMicMuted,
    resetState,
    reset,
    disconnect,
    start,
    toggle,
    end,
    restart,
    resume,
    [Symbol.dispose]() {
      disconnect();
    },
  };
  return session as BrowserSession;
}
