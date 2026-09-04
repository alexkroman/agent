// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Facts } from "./facts.tsx";

describe("Facts", () => {
  test("joins the facts with the separator, and puts none at either end", () => {
    const { container } = render(<Facts items={["6 segments", "12:04 of audio", "1,840 words"]} />);
    // The whole point of the component: the caller never writes `·` or the
    // space beside it, so neither can be missing and neither can be doubled.
    expect(container.textContent).toBe("6 segments · 12:04 of audio · 1,840 words");
  });

  test("a single fact gets no separator at all", () => {
    const { container } = render(<Facts items={["alone"]} />);
    expect(container.textContent).toBe("alone");
  });

  test("false, null, undefined and the empty string are dropped", () => {
    const exhausted = false;
    const { container } = render(
      <Facts
        items={["grounded", exhausted && "budget exhausted", null, undefined, "", "useful"]}
      />,
    );
    // Not "grounded ·  ·  · useful": a dropped fact takes its separator with it.
    expect(container.textContent).toBe("grounded · useful");
  });

  test("zero is a fact, not an absence", () => {
    // The bug a plain truthiness filter ships. `0` prints; `""` does not.
    const { container } = render(<Facts items={[0, "blind cuts"]} />);
    expect(container.textContent).toBe("0 · blind cuts");
  });

  test("renders nothing when every fact was dropped", () => {
    const { container } = render(<Facts items={[false, undefined, null, ""]} />);
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing for an empty list", () => {
    const { container } = render(<Facts items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  test("size picks the size AND the muting together", () => {
    const sm = render(<Facts items={["a"]} />).container.firstElementChild;
    expect(sm?.className).toBe("text-sm opacity-70");
    const xs = render(<Facts items={["a"]} size="xs" />).container.firstElementChild;
    expect(xs?.className).toBe("text-xs opacity-60");
  });

  test("className is added, so a page can reach the other two typographies", () => {
    // `text-xs uppercase tracking-[1.2px] opacity-60` and
    // `text-xs tabular-nums opacity-60` are the two remaining site variants;
    // both are the `xs` pair plus an addition.
    const { container } = render(
      <Facts items={["a"]} size="xs" className="uppercase tracking-[1.2px]" />,
    );
    const cls = container.firstElementChild?.className ?? "";
    expect(cls).toContain("text-xs");
    expect(cls).toContain("opacity-60");
    expect(cls).toContain("uppercase");
  });

  test("renders a <p> by default and a <span> on request", () => {
    // A facts line inside phrasing content cannot be a `<p>` — the parser
    // reparents it out of its wrapper.
    expect(render(<Facts items={["a"]} />).container.firstElementChild?.tagName).toBe("P");
    expect(render(<Facts items={["a"]} as="span" />).container.firstElementChild?.tagName).toBe(
      "SPAN",
    );
  });
});
