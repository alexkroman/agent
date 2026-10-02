// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * `Eyebrow` — the small outlined uppercase label ("Voice Agent", the TOOL
 * chip). It takes a span's own attributes, so the assertions are that those
 * pass through and that a caller's `style` composes with the theme's rather
 * than replacing it.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ThemeProvider } from "../context.ts";
import { Eyebrow } from "./eyebrow.tsx";

describe("Eyebrow", () => {
  test("renders its children in a span with the theme's border and ink", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider value={{ text: "#111111", border: "#222222" }}>
        <Eyebrow>Voice Agent</Eyebrow>
      </ThemeProvider>,
    );
    expect(html).toMatch(/^<span[^>]*>Voice Agent<\/span>$/);
    expect(html).toContain("border-color:#222222");
    expect(html).toContain("color:#111111");
    expect(html).toContain("uppercase");
  });

  test("appends a caller's class and lets its style win, field by field", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider value={{ text: "#111111", border: "#222222" }}>
        <Eyebrow className="shrink-0" style={{ color: "#999999" }}>
          Tool
        </Eyebrow>
      </ThemeProvider>,
    );
    expect(html).toContain("shrink-0");
    expect(html).toContain("color:#999999");
    // The theme's border survives a style that did not name one.
    expect(html).toContain("border-color:#222222");
  });

  test("passes a span's own attributes through", () => {
    const html = renderToStaticMarkup(
      <Eyebrow title="what this is" aria-hidden>
        x
      </Eyebrow>,
    );
    expect(html).toContain('title="what this is"');
    expect(html).toContain('aria-hidden="true"');
  });
});
