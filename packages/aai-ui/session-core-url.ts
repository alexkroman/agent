// Copyright 2025 the AAI authors. MIT license.
// WebSocket URL construction for the browser session core.

/** Build the session WebSocket URL from the platform URL and resume state. */
export function buildWsUrl(platformUrl: string, resume: boolean, sessionId?: string): URL {
  const wsUrl = new URL("websocket", platformUrl.endsWith("/") ? platformUrl : `${platformUrl}/`);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  if (sessionId) wsUrl.searchParams.set("sessionId", sessionId);
  else if (resume) wsUrl.searchParams.set("resume", "1");
  return wsUrl;
}
