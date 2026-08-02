// Copyright 2025 the AAI authors. MIT license.

import { safeJsonParse } from "@alexkroman1/aai";

/** Parse a JSON string, returning the input unchanged when it isn't valid JSON. */
export function tryParseJSON(str: string | undefined): unknown {
  if (!str) return str;
  return safeJsonParse(str) ?? str;
}

/** Truncate a string to `max` characters, appending an ellipsis when cut. */
export function truncate(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * The page this UI is served from — the agent's base URL when none is
 * configured explicitly. One definition so `client()`'s default and the
 * shareable-URL chip can never disagree about which agent the page is.
 */
export function pageBaseUrl(): string {
  if (typeof location === "undefined") return "";
  return location.origin + location.pathname;
}
