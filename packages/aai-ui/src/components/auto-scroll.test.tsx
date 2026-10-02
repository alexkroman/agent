// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * `AutoScroll` — the one owner of stick-to-bottom, shared with the studio.
 *
 * Pinning, releasing on scroll-up and following content that grows are
 * use-stick-to-bottom's, driven by real layout and a `ResizeObserver` — neither
 * of which jsdom provides — so what is asserted is the DOM contract this
 * wrapper adds: a `role="log"` wrapper, then the scroll element, then the
 * content element, each taking its own class.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { AutoScroll } from "./auto-scroll.tsx";

describe("AutoScroll", () => {
  test("is a log wrapping a scroll element wrapping the content", () => {
    render(
      <AutoScroll className="outer" contentClassName="inner" style={{ height: 100 }}>
        <p>first line</p>
      </AutoScroll>,
    );
    const log = screen.getByRole("log");
    expect(log.className).toContain("flex-1");
    expect(log.className).toContain("min-h-0");
    expect(log.className).toContain("outer");
    expect(log.style.height).toBe("100px");

    const scroller = log.firstElementChild;
    const content = scroller?.firstElementChild;
    expect(content?.className).toContain("inner");
    expect(content?.textContent).toBe("first line");
  });

  test("hides the scrollbar by default, and a caller can ask for a native one", () => {
    const { unmount } = render(
      <AutoScroll>
        <p>x</p>
      </AutoScroll>,
    );
    expect(screen.getByRole("log").firstElementChild?.className).toContain(
      "[scrollbar-width:none]",
    );
    unmount();

    render(
      <AutoScroll scrollClassName="overflow-y-auto">
        <p>x</p>
      </AutoScroll>,
    );
    const scroller = screen.getByRole("log").firstElementChild;
    expect(scroller?.className).toContain("overflow-y-auto");
    expect(scroller?.className).not.toContain("[scrollbar-width:none]");
  });
});
