// Copyright 2025 the AAI authors. MIT license.

/**
 * Parse WebSocket upgrade query params into session start options.
 *
 * @internal
 */
export function parseWsUpgradeParams(rawUrl: string): {
  resumeFrom?: string;
  skipGreeting: boolean;
} {
  // Slice from the first "?" (not split[1]) so a query value that itself
  // contains a literal "?" isn't truncated.
  const qIndex = rawUrl.indexOf("?");
  const params = new URLSearchParams(qIndex === -1 ? "" : rawUrl.slice(qIndex + 1));
  // Treat an empty `?sessionId=` as absent: a defined-but-empty id is not a
  // resumable session, and it would also silently suppress the greeting.
  const resumeFrom = params.get("sessionId") || undefined;
  const skipGreeting = resumeFrom !== undefined || params.has("resume");
  return resumeFrom !== undefined ? { resumeFrom, skipGreeting } : { skipGreeting };
}
