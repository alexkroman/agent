// Copyright 2026 the AAI authors. MIT license.
/**
 * @deprecated Import from `@alexkroman1/aai/patterns` instead. This subpath
 * was renamed because "workflow" collided with the `workflow()` app kind
 * (the audio-in → action-out mode built by the root export) — these
 * combinators are unrelated to it. The re-export stays for one release
 * cycle so existing imports keep working.
 */

// biome-ignore lint/performance/noReExportAll: deprecated compatibility barrel for the /patterns rename
export * from "./patterns.ts";
