// Copyright 2025 the AAI authors. MIT license.

/**
 * Framework-agnostic voice session core.
 *
 * Manages WebSocket communication, audio capture/playback, and agent state
 * transitions using a subscribe/getSnapshot pattern compatible with React's
 * `useSyncExternalStore` and other external store consumers.
 *
 * Server→client message interpretation lives in `session-core-messages.ts`;
 * the public/internal type declarations live in `session-core-types.ts`.
 *
 * No dependency on React, Preact, or any UI framework.
 */

import { createEpoch, WS_OPEN } from "@alexkroman1/aai/internal";
import type { SessionCommand } from "@alexkroman1/aai/protocol";
import { initAudioCapture, loadAudioModules } from "./session-core-audio-setup.ts";
import { closeFailure } from "./session-core-close.ts";
import { createDialer } from "./session-core-dial.ts";
import { createHandshakeGuard, HANDSHAKE_ERROR } from "./session-core-handshake.ts";
import {
  CLEARED_SESSION_STATE,
  createMessageHandlers,
  type SessionConfigMessage,
} from "./session-core-messages.ts";
import { reconnectPending } from "./session-core-reconnect.ts";
import { createSessionStateMachine } from "./session-core-state.ts";
import {
  bargeIn,
  type ConnState,
  type SessionCore,
  type SessionSnapshot,
  STOPPED,
} from "./session-core-types.ts";
import { buildWsUrl } from "./session-core-url.ts";
import { MIC_SEND_MAX_BUFFERED_BYTES, type VoiceSessionOptions } from "./types.ts";

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a framework-agnostic voice session core that connects to an AAI
 * server via WebSocket.
 *
 * Uses a subscribe/getSnapshot pattern for state management, compatible with
 * React's `useSyncExternalStore` and other external store integrations.
 *
 * Most clients never call this: `client()` creates a core and installs it in
 * React context for the hooks. Reach for it directly when building a
 * non-React UI (or wiring the session into another framework's store).
 *
 * @example
 * ```ts
 * import { createSessionCore, type SessionSnapshot } from "@alexkroman1/aai-ui";
 *
 * declare function render(snapshot: SessionSnapshot): void;
 *
 * const session = createSessionCore({ platformUrl: "https://host/my-agent/" });
 * session.subscribe(() => render(session.getSnapshot()));
 * session.start();
 * ```
 *
 * @param options - Session configuration including the platform server URL.
 * @returns A {@link SessionCore} handle for controlling the session.
 *
 * @public
 */
export function createSessionCore(options: VoiceSessionOptions): SessionCore {
  // ─── Internal state ─────────────────────────────────────────────────────

  let currentSnapshot: SessionSnapshot = {
    ...CLEARED_SESSION_STATE,
    state: "disconnected",
    contentVersion: 0,
    started: false,
    running: false,
    recording: false,
    // The programmatic endpoint — the LONG-LIVING platform URL
    // (`wss://host/my-agent/websocket`), derived up front so UIs can show it
    // before connecting. Deliberately NOT the brokered sandbox tunnel URL the
    // session may actually connect to: that URL dies with the sandbox (idle
    // eviction, redeploy), while the platform endpoint is stable and upgrades
    // callers to the current sandbox endpoint itself.
    apiUrl: buildWsUrl(options.platformUrl, false).toString(),
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

  function updateState(partial: Partial<SessionSnapshot>): void {
    // A write that changes no field still notified, so every consumer
    // re-rendered on every server event that "cleared" an already-null error or
    // re-announced a state it was already in. Two call sites used to guard that
    // themselves by reading the snapshot back first; now that the state machine
    // answers "did anything move" — a declined transition returns the position
    // unchanged — the check belongs here, where it covers the other thirty
    // callers too. `session-core-events.test.ts` pins both cases.
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
   * thirteen call sites wrote independently — see `session-core-state.ts`,
   * which carries the three shipped bugs that arrangement produced.
   */
  const agentState = createSessionStateMachine();

  const conn: ConnState = {
    ws: null,
    retiredByServer: false,
    voiceIO: null,
    audioSetupInFlight: false,
    generation: createEpoch(),
    turn: createEpoch(),
    preInitAudio: [],
    preInitDone: false,
  };
  let connectionController: AbortController | null = null;

  // The resume identity and the address of the next attempt — see
  // `session-core-dial.ts`, which owns the session id, the storage that carries
  // it across a page RELOAD, the handshake flag, and the broker latch.
  const dialer = createDialer(options);

  function cleanupAudio(): void {
    conn.audioSetupInFlight = false;
    // Releasing the audio path ends whatever turn was playing: closing the
    // AudioContext is what makes a pending `done()` resolve, so without this
    // bump the drain's continuation lands on a session that has already gone
    // disconnected/errored and stamps `state: "listening"` over it.
    conn.turn.bump();
    void conn.voiceIO?.close().catch(() => {
      /* already tearing down — nothing to report the failure to */
    });
    conn.voiceIO = null;
    conn.preInitAudio = [];
    conn.preInitDone = false;
  }

  function resetState(): void {
    updateState(CLEARED_SESSION_STATE);
  }

  /**
   * The socket, when there is one and it can carry a frame.
   *
   * Returning the socket rather than a boolean because every caller needs it
   * next, and a predicate does not narrow `conn.ws` across the call. One
   * spelling of the readiness test, which four call sites used to repeat.
   */
  function openSocket(): ConnState["ws"] {
    return conn.ws?.readyState === WS_OPEN ? conn.ws : null;
  }

  function sendJson(msg: SessionCommand): void {
    openSocket()?.send(JSON.stringify(msg));
  }

  function sendAudio(bytes: ArrayBuffer): void {
    const ws = openSocket();
    if (!ws) return;
    // Backpressure: if the socket's send queue is backed up (slow network),
    // drop this frame instead of queueing. Queued mic audio only adds latency
    // and flushes stale speech into STT once the connection recovers.
    if (ws.bufferedAmount > MIC_SEND_MAX_BUFFERED_BYTES) return;
    ws.send(bytes);
  }

  // ─── Message handling ─────────────────────────────────────────────────────

  const { handleMessage, settleWhenAudioDrained } = createMessageHandlers({
    getSnapshot,
    updateState,
    conn,
    agentState,
    cleanupAudio,
  });

  const audioDeps = {
    sendJson,
    sendAudio,
    updateState,
    agentState,
    settleWhenAudioDrained,
    cleanupAudio,
  };

  // ─── Connection management ──────────────────────────────────────────────

  /** Abort the in-flight connection and release audio + WebSocket resources. */
  function teardownConnection(): void {
    connectionController?.abort();
    connectionController = null;
    cleanupAudio();
    conn.ws?.close();
    conn.ws = null;
  }

  /**
   * React to the server's `session.configured` frame: record it and set up the
   * session's audio path.
   *
   * **It no longer replays history, and the deletion is the point.** A reconnect
   * used to push this snapshot's `messages` back, making the CLIENT the authority
   * on the agent's memory; the server restores the conversation from its own
   * retained event stream now, which also covers what a client cannot — a second
   * tab, a call resuming onto a replacement sandbox, a reopened tab. This
   * snapshot's `messages` are untouched: nothing clears the transcript on screen.
   */
  function onServerConfig(config: SessionConfigMessage): void {
    dialer.configured(config.sid);
    if (config.sid) options.onSessionId?.(config.sid);
    // initAudioCapture handles its own failures (sets error state internally).
    void initAudioCapture(conn, config, audioDeps);
  }

  function connect(opts?: { signal?: AbortSignal }): void {
    // Abort listeners on an already-aborted signal never fire (DOM spec), so
    // honor the documented "aborted ⇒ disconnected" contract up front.
    if (opts?.signal?.aborted) {
      disconnect();
      return;
    }
    updateState(agentState.apply({ type: "CONNECT" }));
    // Prefetch the audio module + worklet sources so the chunk fetch overlaps
    // the WebSocket handshake instead of starting only when the server's
    // `config` frame arrives. Failures are reported by initAudioCapture,
    // which awaits the same memoized load.
    void loadAudioModules().catch(() => {
      /* surfaced by initAudioCapture */
    });
    teardownConnection();
    conn.generation.bump();
    // A fresh connect is the user asking for a session again — clear the
    // previous one's idle retirement so THIS socket can auto-reconnect.
    conn.retiredByServer = false;
    const controller = new AbortController();
    connectionController = controller;
    const { signal: sig } = controller;

    if (opts?.signal) {
      opts.signal.addEventListener("abort", () => disconnect(), {
        signal: sig,
      });
    }

    const socket = dialer.open();
    socket.binaryType = "arraybuffer";
    conn.ws = socket;

    // Browsers fire "error" with no payload and always follow it with
    // "close" — record that it happened so the close handler can report a
    // connection error instead of a plain disconnect.
    let socketErrored = false;

    // A socket that opened but never became a session (session-core-handshake.ts).
    const handshake = createHandshakeGuard({
      socket,
      signal: sig,
      onRetry: () => {
        cleanupAudio();
        conn.generation.bump();
        updateState({ ...agentState.apply({ type: "CONNECT" }), recording: false });
      },
      onExhausted: () => {
        cleanupAudio();
        // Abort first so these listeners are detached and the close below
        // cannot re-enter them with a contradicting state.
        controller.abort();
        socket.close();
        conn.ws = null;
        updateState({
          ...agentState.apply({ type: "FAILED", error: HANDSHAKE_ERROR }),
          ...STOPPED,
        });
      },
    });

    socket.addEventListener(
      "open",
      () => {
        updateState(agentState.apply({ type: "SOCKET_OPEN" }));
        handshake.arm();
      },
      { signal: sig },
    );

    socket.addEventListener(
      "message",
      (event: MessageEvent) => {
        const config = handleMessage(event.data);
        if (!config) return;
        handshake.succeeded();
        onServerConfig(config);
      },
      { signal: sig },
    );

    socket.addEventListener(
      "error",
      () => {
        socketErrored = true;
      },
      { signal: sig },
    );

    socket.addEventListener(
      "close",
      (event) => {
        if (sig.aborted) {
          return;
        }
        // Whatever ends this socket, its handshake is no longer pending —
        // a survivor would fire against the NEXT attempt's open window.
        handshake.disarm();
        cleanupAudio();
        // A FATAL error is the server saying the session cannot work, and it is
        // not retryable by construction — the same rule as `retiredByServer`,
        // read off the latch that already owns the question rather than a second
        // flag every writer would have to set. Without it the ladder ran in full
        // while the page said CONNECTING, and the server's own sentence landed
        // ~110s and 10 socket opens later, when partysocket ran out of retries;
        // on the platform the URL provider re-brokers per attempt, so those ten
        // are ten broker calls that can boot a sandbox. Measured in
        // `session-core-reconnect.test.ts`.
        if (!(conn.retiredByServer || agentState.fatal()) && reconnectPending(socket)) {
          // partysocket retries with backoff. Keep the listeners attached
          // and the session logically alive: the URL provider re-derives the
          // resume URL, and the server restores the conversation itself.
          // Invalidate any audio init still awaiting getUserMedia — the retry
          // will start its own, and cleanupAudio just cleared the in-flight
          // flag, so a survivor would otherwise pass the same-generation
          // guard and double-run (two live mics, duplicate `audio_ready`).
          conn.generation.bump();
          // A socket error here is part of the retry cycle, not terminal —
          // clear it so a later clean disconnect isn't misreported.
          socketErrored = false;
          updateState({ ...agentState.apply({ type: "CONNECT" }), recording: false });
          return;
        }
        // Terminal: explicit close, or retries exhausted. Abort first (detaches
        // these listeners, so the close() below can't re-enter), then cancel
        // any still-scheduled partysocket retry — close() on an already-closed
        // socket is a spec-level no-op.
        controller.abort();
        socket.close();
        conn.ws = null;
        // One event for what used to be a three-way branch on the snapshot. A
        // close behind an `error` phase KEEPS it — downgrading to
        // "disconnected" would hide why the session ended — and a clean close
        // anywhere else retires a lingering non-fatal banner; which of those
        // happens is the `error` state's own `CLOSED` handler, not this
        // caller's to work out. See `session-core-state.ts`.
        // The server's own SENTENCE, when it wrote one. A refusal closes with a
        // reason that already says what to do — "Anthropic LLM: missing API key.
        // Set ANTHROPIC_API_KEY in the agent env." — and this handler used to
        // discard it, so the one thing a misconfigured deployment needed to be
        // told arrived as "WebSocket connection error" or as nothing at all.
        // Measured against a deployed agent with no provider key: code 1011,
        // that exact reason, and a page showing a generic disconnect.
        //
        // A NORMAL close carries no reason worth showing (1000 is the caller
        // hanging up, 1005 is no status at all), so the two ordinary endings are
        // untouched; anything else with text is the peer explaining itself.
        const failure = closeFailure(event, socketErrored);
        const closed =
          failure === null
            ? agentState.apply({ type: "CLOSED" })
            : // `FAILED`, so not fatal — see HANDSHAKE_ERROR for the same call.
              agentState.apply({
                type: "FAILED",
                error: { code: "connection", message: failure, fatal: false },
              });
        updateState({ ...closed, ...STOPPED });
      },
      { signal: sig },
    );
  }

  function cancel(): void {
    // Only meaningful mid-session: called while disconnected/errored it would
    // fake a "listening" state with nobody on the other end.
    if (!openSocket()) return;
    // A client-side barge-in is a turn boundary exactly as the server's
    // `cancelled` frame is: the flush below settles the interrupted turn's
    // drain, whose continuation must not outlive the turn it belonged to.
    bargeIn(conn);
    updateState(agentState.apply({ type: "LISTEN" }));
    sendJson({ type: "cancel" });
  }

  function reset(): void {
    bargeIn(conn);
    if (openSocket()) {
      sendJson({ type: "reset" });
      return;
    }
    // No socket, so the `reset` frame above went nowhere and this redial is
    // what starts the new conversation. `end()` is the whole clear-and-forget:
    // it drops the resume identity, so `start()` redials without
    // `?sessionId=`/`resume=1` — a resume rejoins the conversation in progress,
    // keeping the server's history and suppressing the greeting. `start()`
    // also leaves the session running, so the controls don't show "Resume".
    end();
    start();
  }

  function disconnect(): void {
    teardownConnection();
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
    teardownConnection();
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

  return {
    getSnapshot,
    subscribe,
    connect,
    cancel,
    resetState,
    reset,
    disconnect,
    start,
    toggle,
    end,
    [Symbol.dispose]() {
      disconnect();
    },
  };
}
