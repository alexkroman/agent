// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent page's favicon is a `data:` URI, which is a format with two silent
 * failure modes — so it gets its own spec rather than being eyeballed once.
 *
 * A broken icon is invisible in review (the link still looks right), invisible
 * in a unit run (nothing renders it), and reaches production as either a blank
 * tab icon or the 404 this constant exists to remove.
 */

import { describe, expect, test } from "vitest";
import { AGENT_CSP, AGENT_FAVICON } from "./constants.ts";

/** The SVG the URI carries, as a browser would decode it. */
function decoded(): string {
  return decodeURIComponent(AGENT_FAVICON.replace(/^data:image\/svg\+xml,/, ""));
}

describe("AGENT_FAVICON", () => {
  test("is an SVG data URI", () => {
    expect(AGENT_FAVICON.startsWith("data:image/svg+xml,")).toBe(true);
    const svg = decoded();
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"'.replace(/"/g, "'"));
    // A square viewBox: a favicon is rendered into a square box, and the
    // wordmark this mark is taken from is 141x24.
    const viewBox = /viewBox='([^']+)'/.exec(svg)?.[1]?.split(" ").map(Number);
    expect(viewBox).toHaveLength(4);
    expect(viewBox?.[2]).toBe(viewBox?.[3]);
  });

  test("contains no character that truncates or breaks the URI", () => {
    const body = AGENT_FAVICON.slice("data:image/svg+xml,".length);
    // A literal `#` starts the FRAGMENT — the browser would silently drop
    // everything after it, which for a two-color mark means the icon loses a
    // path or fails to parse. Brand colors are `#2545D3`/`#566DE8`, so this is
    // the mistake the encoding exists to prevent.
    expect(body).not.toContain("#");
    expect(decoded()).toContain("#2545D3");
    // A literal `"` would close the HTML attribute the URI sits in.
    expect(body).not.toContain('"');
    // Raw `<`/`>` are not legal in a URI and break some parsers.
    expect(body).not.toContain("<");
    expect(body).not.toContain(">");
  });

  test("both brand paths survived the encoding", () => {
    const svg = decoded();
    // Two paths, two blues — one path means the mark is half drawn, which reads
    // as a plausible-looking icon rather than as an error.
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain("#2545D3");
    expect(svg).toContain("#566DE8");
  });

  test("is allowed by the page's own CSP", () => {
    // `img-src` governs `<link rel="icon">`. Shipping an icon the CSP blocks
    // would trade a 404 for a console violation — the same problem, relocated.
    expect(AGENT_CSP).toContain("img-src 'self' data:");
  });

  test("is small enough to inline in every page", () => {
    // Inlining costs bytes on every HTML response. A rasterized PNG of the same
    // mark is several KB; this is the reason SVG was chosen.
    expect(AGENT_FAVICON.length).toBeLessThan(2048);
  });
});
