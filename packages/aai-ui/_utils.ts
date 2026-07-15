// Copyright 2025 the AAI authors. MIT license.

/** Parse a JSON string, returning the input unchanged when it isn't valid JSON. */
export function tryParseJSON(str: string | undefined): unknown {
  if (!str) return str;
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

/** Truncate a string to `max` characters, appending an ellipsis when cut. */
export function truncate(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
