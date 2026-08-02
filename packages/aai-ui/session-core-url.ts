// Copyright 2025 the AAI authors. MIT license.
// WebSocket URL construction for the browser session core.

import { buildAgentUrl } from "./client-config.ts";

/** Build the session WebSocket URL from the platform URL and resume state. */
export function buildWsUrl(platformUrl: string, resume: boolean, sessionId?: string): URL {
  return applyResumeParams(buildAgentUrl(platformUrl, "websocket"), resume, sessionId);
}

/**
 * Turn a broker-provided session URL (`sessionUrl` from `GET client-config`
 * — the agent's live sandbox endpoint) into this attempt's connect URL.
 */
export function buildBrokeredWsUrl(sessionUrl: string, resume: boolean, sessionId?: string): URL {
  return applyResumeParams(new URL(sessionUrl), resume, sessionId);
}

const WS_PROTOCOLS: Record<string, string> = { "https:": "wss:", "http:": "ws:" };

function applyResumeParams(wsUrl: URL, resume: boolean, sessionId?: string): URL {
  wsUrl.protocol = WS_PROTOCOLS[wsUrl.protocol] ?? wsUrl.protocol;
  if (sessionId) wsUrl.searchParams.set("sessionId", sessionId);
  else if (resume) wsUrl.searchParams.set("resume", "1");
  return wsUrl;
}
