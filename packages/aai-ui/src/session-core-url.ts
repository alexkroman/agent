// Copyright 2025 the AAI authors. MIT license.
// WebSocket URL construction for the browser session core.

import { buildAgentUrl } from "./client-config.ts";

/**
 * What the client reports about itself on every attempt: `?location=`,
 * `?phone=` and `?client=`, each already resolved and trimmed (empty = not
 * reported).
 */
export type ClientReport = {
  location?: string | undefined;
  phone?: string | undefined;
  client?: string | undefined;
};

/** Build the session WebSocket URL from the platform URL and resume state. */
export function buildWsUrl(
  platformUrl: string,
  resume: boolean,
  sessionId?: string,
  report: ClientReport = {},
): URL {
  return applyResumeParams(buildAgentUrl(platformUrl, "websocket"), resume, sessionId, report);
}

/**
 * Turn a broker-provided session URL (`sessionUrl` from `GET client-config`
 * — the agent's live sandbox endpoint) into this attempt's connect URL.
 */
export function buildBrokeredWsUrl(
  sessionUrl: string,
  resume: boolean,
  sessionId?: string,
  report: ClientReport = {},
): URL {
  return applyResumeParams(new URL(sessionUrl), resume, sessionId, report);
}

const WS_PROTOCOLS: Record<string, string> = { "https:": "wss:", "http:": "ws:" };

function applyResumeParams(
  wsUrl: URL,
  resume: boolean,
  sessionId: string | undefined,
  report: ClientReport,
): URL {
  wsUrl.protocol = WS_PROTOCOLS[wsUrl.protocol] ?? wsUrl.protocol;
  if (sessionId) wsUrl.searchParams.set("sessionId", sessionId);
  else if (resume) wsUrl.searchParams.set("resume", "1");
  // On EVERY attempt, resume or not: the server keeps what the client reported
  // per session but reads it from the upgrade, so an attempt without it reads
  // as "unknown". `set`, not `append`: a broker `sessionUrl` that already
  // carried one is overridden by what this client says now, never sent twice.
  if (report.location) wsUrl.searchParams.set("location", report.location);
  if (report.phone) wsUrl.searchParams.set("phone", report.phone);
  if (report.client) wsUrl.searchParams.set("client", report.client);
  return wsUrl;
}
