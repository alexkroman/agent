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
 * configured explicitly. One definition so `mountClient()`'s default and the
 * shareable-URL chip can never disagree about which agent the page is.
 */
export function pageBaseUrl(): string {
  if (typeof location === "undefined") return "";
  return location.origin + location.pathname;
}

/**
 * Set the document title, when there is one to set and a document to set it on.
 *
 * Both mounts do this and neither may clobber a title the page's own HTML
 * declared — `mountClient()`'s custom-component tier because there is no shell header
 * to show the name in, `mountPage()` because there is no shell at all. One copy, for
 * the reason `resolveContainer` and `mountRoot` are shared: the rule is the
 * same, so the two mounts must not be able to disagree about it.
 */
export function setPageTitle(name: string | undefined): void {
  if (name && typeof document !== "undefined") document.title = name;
}
