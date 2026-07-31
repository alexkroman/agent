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

import { WS_OPEN } from "@alexkroman1/aai";
import type { ClientMessage } from "@alexkroman1/aai/protocol";
import { initAudioCapture } from "./session-core-audio-setup.ts";
import {
  CLEARED_SESSION_STATE,
  createMessageHandlers,
  type SessionConfigMessage,
} from "./session-core-messages.ts";
import { openReconnectingSocket, reconnectPending } from "./session-core-reconnect.ts";
import type {
  ConnState,
  SessionCore,
  SessionCoreOptions,
  SessionSnapshot,
} from "./session-core-types.ts";
import { buildWsUrl } from "./session-core-url.ts";
import { MIC_SEND_MAX_BUFFERED_BYTES, type WebSocketConstructor } from "./types.ts";

export type {
  CustomEvent,
  SessionCore,
  SessionCoreOptions,
  SessionSnapshot,
} from "./session-core-types.ts";

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a framework-agnostic voice session core that connects to an AAI
 * server via WebSocket.
 *
 * Uses a subscribe/getSnapshot pattern for state management, compatible with
 * React's `useSyncExternalStore` and other external store integrations.
 *
 * @param options - Session configuration including the platform server URL.
 * @returns A {@link SessionCore} handle for controlling the session.
 *
 * @public
 */
export function createSessionCore(options: SessionCoreOptions): SessionCore {
  // ─── Internal state (replaces signals) ──────────────────────────────────

  let currentSnapshot: SessionSnapshot = {
    ...CLEARED_SESSION_STATE,
    state: "disconnected",
    contentVersion: 0,
    started: false,
    running: false,
    recording: false,
    // The programmatic endpoint — same URL the session connects to, minus
    // resume params. Derived up front so UIs can show it before connecting.
    apiUrl: buildWsUrl(options.platformUrl, false).toString(),
  };

  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const sub of subscribers) sub();
  }

  /** Snapshot fields whose changes bump `contentVersion` (rendered conversation content). */
  const contentKeys = ["messages", "toolCalls", "userTranscript", "agentTranscript"] as const;

  function updateState(partial: Partial<SessionSnapshot>): void {
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

  const conn: ConnState = {
    ws: null,
    voiceIO: null,
    audioSetupInFlight: false,
    generation: 0,
    preInitAudio: [],
    preInitDone: false,
    readyConfig: null,
  };
  let connectionController: AbortController | null = null;
  let hasConnected = false;
  /**
   * The session ID to resume: seeded from `options.resumeSessionId`, then
   * kept current from every `config` frame. Reconnect URLs carry it as
   * `?sessionId=<id>` so the server re-registers the SAME session id —
   * that key is what per-session tool state (`ctx.state`) lives under, so
   * a reconnect that omits it gets a fresh session with none of the
   * agent's context, greeting suppression aside.
   */
  let sessionId: string | undefined = options.resumeSessionId;

  function cleanupAudio(): void {
    conn.audioSetupInFlight = false;
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

  function sendJson(msg: ClientMessage): void {
    if (conn.ws && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  function sendAudio(bytes: Uint8Array): void {
    if (!conn.ws || conn.ws.readyState !== WS_OPEN) return;
    // Backpressure: if the socket's send queue is backed up (slow network),
    // drop this frame instead of queueing. Queued mic audio only adds latency
    // and flushes stale speech into STT once the connection recovers.
    if (conn.ws.bufferedAmount > MIC_SEND_MAX_BUFFERED_BYTES) return;
    conn.ws.send(bytes as unknown as ArrayBuffer);
  }

  // ─── Message handling ─────────────────────────────────────────────────────

  const { handleMessage, settleWhenAudioDrained } = createMessageHandlers({
    getSnapshot,
    updateState,
    conn,
    cleanupAudio,
  });

  const audioDeps = {
    sendJson,
    sendAudio,
    updateState,
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

  /** React to the server's `config` message: record it, set up the audio
   *  path for the session's mode, and replay history on reconnect. */
  function onServerConfig(config: SessionConfigMessage): void {
    if (config.sid) {
      sessionId = config.sid;
      options.onSessionId?.(config.sid);
    }
    const isReconnect = hasConnected;
    hasConnected = true;
    conn.readyConfig = { sampleRate: config.sampleRate, ttsSampleRate: config.ttsSampleRate };
    // initAudioCapture handles its own failures (sets error state internally).
    // Fatal: a voice session without a mic cannot function.
    void initAudioCapture(conn, config, audioDeps, true);

    if (isReconnect && currentSnapshot.messages.length > 0) {
      sendJson({
        type: "history",
        messages: currentSnapshot.messages.map((m) => ({ role: m.role, content: m.content })),
      });
    }
  }

  /**
   * The WebSocket URL for the *next* connection attempt. Evaluated per
   * attempt (partysocket takes it as a URL provider), so once the first
   * `config` arrives, every reconnect — automatic or explicit — carries
   * `?sessionId=<id>` and the server resumes the SAME session (id, tool
   * state) instead of minting a new one. `resume=1` remains only as the
   * greeting-suppression fallback for a server whose config carried no id.
   */
  function currentWsUrl(): string {
    return buildWsUrl(options.platformUrl, hasConnected, sessionId).toString();
  }

  /** Open a socket: an injected constructor as-is (tests), or partysocket's
   *  reconnecting WebSocket — same interface, plus reconnect-on-close. */
  function openSocket(): InstanceType<WebSocketConstructor> {
    if (options.WebSocket) return new options.WebSocket(currentWsUrl());
    const socket = openReconnectingSocket(currentWsUrl);
    return socket as unknown as InstanceType<WebSocketConstructor>;
  }

  function connect(opts?: { signal?: AbortSignal }): void {
    // Abort listeners on an already-aborted signal never fire (DOM spec), so
    // honor the documented "aborted ⇒ disconnected" contract up front.
    if (opts?.signal?.aborted) {
      disconnect();
      return;
    }
    updateState({ state: "connecting", error: null });
    teardownConnection();
    conn.generation++;
    const controller = new AbortController();
    connectionController = controller;
    const { signal: sig } = controller;

    if (opts?.signal) {
      opts.signal.addEventListener("abort", () => disconnect(), {
        signal: sig,
      });
    }

    const socket = openSocket();
    socket.binaryType = "arraybuffer";
    conn.ws = socket;

    // Browsers fire "error" with no payload and always follow it with
    // "close" — record that it happened so the close handler can report a
    // connection error instead of a plain disconnect.
    let socketErrored = false;

    socket.addEventListener(
      "open",
      () => {
        updateState({ state: "ready" });
      },
      { signal: sig },
    );

    socket.addEventListener(
      "message",
      (event: MessageEvent) => {
        const config = handleMessage(event.data);
        if (config) onServerConfig(config);
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
      () => {
        if (sig.aborted) {
          return;
        }
        cleanupAudio();
        if (reconnectPending(socket)) {
          // partysocket retries with backoff. Keep the listeners attached
          // and the session logically alive: the URL provider re-derives the
          // resume URL and `onServerConfig` replays history on the next open.
          // Invalidate any audio init still awaiting getUserMedia — the retry
          // will start its own, and cleanupAudio just cleared the in-flight
          // flag, so a survivor would otherwise pass the same-generation
          // guard and double-run (two live mics, duplicate `audio_ready`).
          conn.generation++;
          // A socket error here is part of the retry cycle, not terminal —
          // clear it so a later clean disconnect isn't misreported.
          socketErrored = false;
          updateState({ state: "connecting", recording: false });
          return;
        }
        // Terminal: explicit close, or retries exhausted. Abort first (detaches
        // these listeners, so the close() below can't re-enter), then cancel
        // any still-scheduled partysocket retry — close() on an already-closed
        // socket is a spec-level no-op.
        controller.abort();
        socket.close();
        conn.ws = null;
        if (socketErrored) {
          updateState({
            state: "error",
            error: { code: "connection", message: "WebSocket connection error" },
            running: false,
            recording: false,
          });
        } else if (currentSnapshot.state === "error") {
          // Keep a fatal error on screen — downgrading it to "disconnected"
          // would hide why the session ended.
          updateState({ running: false, recording: false });
        } else {
          // A clean close also retires any lingering non-fatal error banner.
          updateState({ state: "disconnected", error: null, running: false, recording: false });
        }
      },
      { signal: sig },
    );
  }

  function cancel(): void {
    // Only meaningful mid-session: called while disconnected/errored it would
    // fake a "listening" state with nobody on the other end.
    if (!conn.ws || conn.ws.readyState !== WS_OPEN) return;
    conn.voiceIO?.flush();
    updateState({ state: "listening" });
    sendJson({ type: "cancel" });
  }

  function reset(): void {
    conn.voiceIO?.flush();
    if (conn.ws && conn.ws.readyState === WS_OPEN) {
      sendJson({ type: "reset" });
      return;
    }
    resetState();
    disconnect();
    // The reconnect keeps the session live — without this, `running` stays
    // false and the controls show "Resume" on a freshly connected session.
    updateState({ running: true });
    connect();
  }

  function disconnect(): void {
    teardownConnection();
    updateState({ state: "disconnected", running: false, recording: false });
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
    [Symbol.dispose]() {
      disconnect();
    },
  };
}
