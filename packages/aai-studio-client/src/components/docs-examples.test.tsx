// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// One worked example: the SDK call up front, each alternate language behind a
// `<details>` that keeps it in the DOM (a page search for `curl` still finds it).

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Examples, FollowUp } from "./docs-examples.tsx";

describe("Examples", () => {
  test("with no alternates, it is the one snippet and no disclosure", () => {
    const { container } = render(<Examples code="agent.list()" label="List workflows" />);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("details")).toBeNull();
    expect(screen.getByLabelText("Copy: List workflows")).toBeTruthy();
  });

  test("the SDK leads and each alternate is a closed disclosure, still in the DOM", () => {
    const { container } = render(
      <Examples
        code="agent.list()"
        label="List workflows"
        alternates={[
          { language: "curl", code: "curl https://a.test/workflows" },
          { language: "the aai CLI", code: "aai workflow list" },
        ]}
      />,
    );
    const pres = [...container.querySelectorAll("pre")].map((p) => p.textContent);
    expect(pres).toEqual(["agent.list()", "curl https://a.test/workflows", "aai workflow list"]);

    const details = [...container.querySelectorAll("details")];
    expect(details).toHaveLength(2);
    for (const d of details) expect(d.open).toBe(false);
    expect(details.map((d) => d.querySelector("summary")?.textContent)).toEqual([
      "Same call with curl",
      "Same call with the aai CLI",
    ]);
  });

  test("each alternate's copy button names its language", () => {
    render(
      <Examples
        code="x"
        label="Start a run"
        alternates={[{ language: "curl", code: "curl -X POST" }]}
      />,
    );
    expect(screen.getByLabelText("Copy: Start a run")).toBeTruthy();
    expect(screen.getByLabelText("Copy: Start a run with curl")).toBeTruthy();
  });
});

describe("FollowUp", () => {
  test("puts the note above the example it introduces", () => {
    const { container } = render(
      <FollowUp note="Then wait for the result:">
        <pre>agent.wait(id)</pre>
      </FollowUp>,
    );
    const text = container.textContent ?? "";
    expect(text.indexOf("Then wait for the result:")).toBeLessThan(text.indexOf("agent.wait(id)"));
  });
});
