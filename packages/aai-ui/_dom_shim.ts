// Copyright 2025 the AAI authors. MIT license.
import { DOMParser } from "linkedom";

export { DOMParser };

let installed = false;

/**
 * Install linkedom globals so Preact can render in Node.js SSR (render checks).
 */
export function installDomShim(): void {
  if (installed) return;
  installed = true;

  const doc = new DOMParser().parseFromString(
    "<!DOCTYPE html><html><head></head><body></body></html>",
    "text/html",
  );

  const g = globalThis as unknown as Record<string, unknown>;
  g.document = doc;
  g.HTMLElement = doc.documentElement.constructor;

  // Stub scrollIntoView — not implemented in linkedom.
  if (
    !Object.getOwnPropertyDescriptor(
      (g.HTMLElement as { prototype: Record<string, unknown> }).prototype,
      "scrollIntoView",
    )
  ) {
    (g.HTMLElement as { prototype: Record<string, unknown> }).prototype.scrollIntoView = () => {};
  }
}
