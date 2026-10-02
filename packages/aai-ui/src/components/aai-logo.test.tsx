// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * `AaiLogo` — the wordmark on the start card and in the header.
 *
 * Static markup is enough: the logo has no state, and what a caller depends
 * on is its accessible name, its size and that the WORDMARK follows the
 * theme's text colour while the mark keeps the brand's own two blues.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ThemeProvider } from "../context.ts";
import { AaiLogo } from "./aai-logo.tsx";

describe("AaiLogo", () => {
  test("is one labelled image, 20px tall by default", () => {
    const html = renderToStaticMarkup(<AaiLogo />);
    expect(html).toMatch(/^<svg[^>]*role="img"/);
    expect(html).toContain('aria-label="AssemblyAI"');
    expect(html).toContain('height="20"');
  });

  test("takes the height it is given and keeps its aspect ratio", () => {
    const html = renderToStaticMarkup(<AaiLogo size={32} />);
    expect(html).toContain('height="32"');
    expect(html).toContain('viewBox="0 0 141 24"');
    expect(html).not.toContain("width=");
  });

  test("the wordmark is the theme's ink; the mark stays brand blue", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider value={{ text: "#123456" }}>
        <AaiLogo />
      </ThemeProvider>,
    );
    expect(html).toContain("color:#123456");
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('fill="#2545D3"');
  });
});
