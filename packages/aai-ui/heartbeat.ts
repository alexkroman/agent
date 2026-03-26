// Copyright 2025 the AAI authors. MIT license.
/** Client-side WebSocket heartbeat using application-level ping/pong. */

import type { ClientMessage, ReadyConfig } from "@alexkroman1/aai/protocol";
import { PROTOCOL_VERSION, toWireMessages } from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { VoiceIO } from "./audio.ts";
import type { AgentState, Message, Reactive, SessionError } from "./types.ts";

/** Shared mutable connection state (matches session.ts ConnState). */
type ConnState = {
  ws: WebSocket | null;
  voiceIO: VoiceIO | null;
  audioSetupInFlight: boolean;
  generation: number;
};

const CLIENT_PING_INTERVAL_MS = 30_000;
const CLIENT_PONG_TIMEOUT_MS = 10_000;

export type ClientHeartbeat = {
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
};

export function clearClientHeartbeat(hb: ClientHeartbeat): void {
  if (hb.pingTimer) clearInterval(hb.pingTimer);
  if (hb.pongTimer) clearTimeout(hb.pongTimer);
  hb.pingTimer = null;
  hb.pongTimer = null;
}

export function startClientHeartbeat(
  hb: ClientHeartbeat,
  ws: WebSocket | null,
  sendFn: (msg: ClientMessage) => void,
): void {
  clearClientHeartbeat(hb);
  hb.pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearClientHeartbeat(hb);
      return;
    }
    sendFn({ type: "ping" });
    hb.pongTimer = setTimeout(() => {
      console.warn("Server pong timeout — closing connection");
      ws?.close();
    }, CLIENT_PONG_TIMEOUT_MS);
  }, CLIENT_PING_INTERVAL_MS);
}

/** Handle an incoming pong message; returns true if handled. */
export function handlePong(data: unknown, hb: ClientHeartbeat): boolean {
  if (typeof data !== "string") return false;
  try {
    const json = JSON.parse(data);
    if (json && json.type === "pong") {
      if (hb.pongTimer) {
        clearTimeout(hb.pongTimer);
        hb.pongTimer = null;
      }
      return true;
    }
  } catch {
    /* not JSON */
  }
  return false;
}

export type ConfigHandlerDeps = {
  conn: ConnState;
  hb: ClientHeartbeat;
  send: (msg: ClientMessage) => void;
  audioDeps: {
    send: (msg: ClientMessage) => void;
    sendBinary: (data: ArrayBuffer) => void;
    state: Reactive<AgentState>;
    error: Reactive<SessionError | null>;
    batch: (fn: () => void) => void;
  };
  messages: Reactive<Message[]>;
  hasConnected: { value: boolean };
  initAudio: (
    conn: ConnState,
    msg: ReadyConfig,
    audioDeps: ConfigHandlerDeps["audioDeps"],
  ) => Promise<void>;
};

/** Process a config message: check protocol version, start heartbeat, init audio. */
export function handleConfigMessage(config: ReadyConfig, deps: ConfigHandlerDeps): void {
  if (config.protocolVersion !== undefined && config.protocolVersion > PROTOCOL_VERSION) {
    console.warn(
      `Server protocol version ${config.protocolVersion} is newer than client ${PROTOCOL_VERSION}. ` +
        "Consider refreshing the page.",
    );
  }
  const isReconnect = deps.hasConnected.value;
  deps.hasConnected.value = true;
  startClientHeartbeat(deps.hb, deps.conn.ws, deps.send);
  deps.initAudio(deps.conn, config, deps.audioDeps).catch((err) => {
    deps.audioDeps.batch(() => {
      deps.audioDeps.error.value = {
        code: "audio",
        message: `Audio capture failed: ${errorMessage(err)}`,
      };
      deps.audioDeps.state.value = "error";
    });
  });
  if (isReconnect && deps.messages.value.length > 0) {
    deps.send({ type: "history", messages: toWireMessages(deps.messages.value) });
  }
}
