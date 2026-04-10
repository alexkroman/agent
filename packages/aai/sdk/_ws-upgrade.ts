// Copyright 2025 the AAI authors. MIT license.

/** Parse WebSocket upgrade query params into session start options. */
export function parseWsUpgradeParams(rawUrl: string): {
  resumeFrom: string | undefined;
  skipGreeting: boolean;
} {
  const search = rawUrl.includes("?") ? (rawUrl.split("?")[1] ?? "") : "";
  const params = new URLSearchParams(search);
  const resumeFrom = params.get("sessionId") ?? undefined;
  const skipGreeting = params.has("resume") || resumeFrom !== undefined;
  return { resumeFrom, skipGreeting };
}
