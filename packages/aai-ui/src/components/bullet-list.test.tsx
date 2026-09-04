// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { BulletList } from "./bullet-list.tsx";

/** Every `console.error` React wrote during one render, as one string. */
function renderWatchingConsole(node: React.ReactNode): { html: string; errors: string } {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {
    /* swallowed: the A/B test below deliberately provokes one */
  });
  const { container } = render(node);
  const errors = spy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
  return { html: container.innerHTML, errors };
}

describe("BulletList", () => {
  test("renders one <li> per item inside a disc list", () => {
    const { container } = render(<BulletList items={["alpha", "beta"]} />);
    const items = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual(["alpha", "beta"]);
    expect(container.querySelector("ul")?.className).toContain("list-disc");
  });

  test("renders nothing at all when there are no items", () => {
    const { container } = render(<BulletList items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing when there are no items EVEN WITH a title", () => {
    // The defect in three of the five copies: a heading over a void. The guard
    // has to cover the wrapper, not just the `<ul>`.
    const { container } = render(<BulletList title="Risks" items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  test("wraps in a section with a heading when titled, and does not when not", () => {
    const titled = render(<BulletList title="Risks" items={["one"]} />).container;
    expect(titled.querySelector("section > h3")?.textContent).toBe("Risks");
    expect(titled.querySelector("section > ul")).not.toBeNull();

    const bare = render(<BulletList items={["one"]} />).container;
    expect(bare.querySelector("section")).toBeNull();
    expect(bare.firstElementChild?.tagName).toBe("UL");
  });

  test("a title of false or null is no title, not an empty heading", () => {
    // `title={cond && "Risks"}` is the shape a page reaches for.
    for (const title of [false, null] as const) {
      const { container } = render(<BulletList title={title} items={["one"]} />);
      expect(container.querySelector("h3")).toBeNull();
      expect(container.firstElementChild?.tagName).toBe("UL");
    }
  });

  test("size=sm adds text-sm and the default adds nothing", () => {
    const small = render(<BulletList items={["one"]} size="sm" />).container;
    expect(small.querySelector("ul")?.className).toContain("text-sm");
    const base = render(<BulletList items={["one"]} />).container;
    expect(base.querySelector("ul")?.className).not.toContain("text-sm");
  });

  test("className is added to the list's own classes, not swapped for them", () => {
    const { container } = render(<BulletList items={["one"]} className="opacity-70" />);
    const cls = container.querySelector("ul")?.className ?? "";
    expect(cls).toContain("opacity-70");
    expect(cls).toContain("list-disc");
  });

  test("duplicate items render twice and warn about nothing", () => {
    // These lists are model output, so two identical bullets are plausible —
    // which is what made keying by the string itself a latent collision in all
    // five copies this replaced.
    const { html, errors } = renderWatchingConsole(
      <BulletList items={["repeat me", "repeat me", "and again", "repeat me"]} />,
    );
    expect(errors).toBe("");
    expect(html.match(/<li>/g)).toHaveLength(4);
  });

  test("the duplicate-key detector above is not vacuous", () => {
    // A/B for the assertion in the previous test: the shape every copy used —
    // `key={item}` — really does make React complain on the same input, so a
    // silent `console.error` there is evidence rather than an empty spy.
    const items = ["repeat me", "repeat me"];
    const { errors } = renderWatchingConsole(
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>,
    );
    expect(errors).toContain("same key");
  });
});
