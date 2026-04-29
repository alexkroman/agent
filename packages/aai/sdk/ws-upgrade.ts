// Copyright 2025 the AAI authors. MIT license.

/** Parse WebSocket upgrade query params into session start options. */
export function parseWsUpgradeParams(rawUrl: string): {
  resumeFrom?: string;
  skipGreeting: boolean;
} {
  const params = new URLSearchParams(rawUrl.split("?")[1] ?? "");
  const resumeFrom = params.get("sessionId") ?? undefined;
  const skipGreeting = resumeFrom !== undefined || params.has("resume");
  return resumeFrom !== undefined ? { resumeFrom, skipGreeting } : { skipGreeting };
}
