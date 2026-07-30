// Copyright 2026 the AAI authors. MIT license.

/**
 * Blob-URL module for an inlined AudioWorklet processor source.
 *
 * A blob URL rather than a data URI because the agent page's CSP allows
 * `script-src blob:` but not `data:` — a data-URI module fails `addModule`
 * with the opaque "Unable to load a worklet's module". Every inline worklet
 * in this package must load through this helper so that constraint lives in
 * one place.
 */
export function workletModuleUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
}
