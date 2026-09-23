// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The shared section card. Its title is the `.eyebrow` — the one selector
// suites read card titles through, because a blurb can repeat the title word.

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Card } from "./settings-card.tsx";

describe("Card", () => {
  test("renders the title as the eyebrow, then the blurb, then the body", () => {
    const { container } = render(
      <Card title="Secrets" blurb="Secrets are passed to your agent.">
        <button type="button">Save</button>
      </Card>,
    );
    const section = container.querySelector("section");
    expect(section).not.toBeNull();
    expect(section?.querySelector(".eyebrow")?.textContent).toBe("Secrets");
    const text = section?.textContent ?? "";
    expect(text.indexOf("Secrets are passed")).toBeGreaterThan(text.indexOf("Secrets"));
    expect(text.indexOf("Save")).toBeGreaterThan(text.indexOf("Secrets are passed"));
  });

  test("the eyebrow is the only place the title is read from", () => {
    const { container } = render(<Card title="Database" blurb="Database setup lives here." />);
    const eyebrows = container.querySelectorAll(".eyebrow");
    expect(eyebrows).toHaveLength(1);
    expect(eyebrows[0]?.textContent).toBe("Database");
  });

  test("a blurb may be markup, and the body is optional", () => {
    render(
      <Card
        title="Work locally"
        blurb={
          <>
            Run <code>aai pull</code>.
          </>
        }
      />,
    );
    expect(screen.getByText("aai pull").tagName).toBe("CODE");
  });
});
