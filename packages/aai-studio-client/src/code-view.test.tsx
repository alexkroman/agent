// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// FileNav is the affordance that keeps large workspaces navigable: a
// directory-grouped sidebar list. The buffer rules moved out to file-drafts.ts
// (and its two suites) when they were lifted above this component — see that
// module for why they could not stay here.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FileNav } from "./code-view.tsx";

describe("FileNav", () => {
  // No vitest globals in this package, so testing-library's auto-cleanup
  // never registers — without this each render accumulates in the DOM.
  afterEach(cleanup);

  test("groups files by directory and selects by full path", () => {
    const onSelectFile = vi.fn();
    const paths = [
      "agent.ts",
      "seed.json",
      ...Array.from({ length: 8 }, (_, i) => `tools/tool_${i}.ts`),
    ];
    render(<FileNav paths={paths} currentFile="tools/tool_3.ts" onSelectFile={onSelectFile} />);
    const nav = screen.getByRole("navigation", { name: "Workspace files" });
    // One directory header, entries shown by basename.
    expect(nav.textContent).toContain("tools/");
    const active = screen.getByRole("button", { name: "tool_3.ts" });
    expect(active.getAttribute("aria-current")).toBe("true");
    expect(active.getAttribute("title")).toBe("tools/tool_3.ts");
    screen.getByRole("button", { name: "tool_1.ts" }).click();
    expect(onSelectFile).toHaveBeenCalledWith("tools/tool_1.ts");
  });

  test("lists root files before directories", () => {
    const paths = [...Array.from({ length: 8 }, (_, i) => `tools/tool_${i}.ts`), "agent.ts"].sort();
    render(<FileNav paths={paths} currentFile={null} onSelectFile={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]?.textContent).toBe("agent.ts");
  });
});
