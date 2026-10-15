// Copyright 2026 the AAI authors. MIT license.
// The icon set's contract: decorative (hidden from assistive tech), drawn in
// `currentColor`, and sized by the caller with a per-icon default.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import * as icons from "./icons.tsx";

const ALL = Object.entries(icons);

describe("icons", () => {
  test.each(ALL)("%s is decorative and takes the text color", (_name, Glyph) => {
    const html = renderToStaticMarkup(<Glyph />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("currentColor");
  });

  test("a line icon defaults to 16px and honours a size", () => {
    expect(renderToStaticMarkup(<icons.PlayIcon />)).toContain('width="16"');
    expect(renderToStaticMarkup(<icons.PlayIcon size={12} />)).toContain('width="12"');
  });

  test("the inline marks (chevrons, check, spinner) default to 14px", () => {
    for (const Glyph of [icons.ChevronDownIcon, icons.CheckIcon, icons.SpinnerIcon]) {
      expect(renderToStaticMarkup(<Glyph />)).toContain('width="14"');
    }
  });
});
