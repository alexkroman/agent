// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// FileNav is the affordance that keeps large workspaces navigable: a
// directory-grouped sidebar list. The buffer rules moved out to file-drafts.ts
// (and its two suites) when they were lifted above this component — see that
// module for why they could not stay here.

import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { FileNav, OwnershipBanner } from "./code-view.tsx";

describe("FileNav", () => {
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
    expect(nav).toHaveTextContent("tools/");
    const active = screen.getByRole("button", { name: "tool_3.ts" });
    expect(active).toHaveAttribute("aria-current", "true");
    expect(active).toHaveAttribute("title", "tools/tool_3.ts");
    screen.getByRole("button", { name: "tool_1.ts" }).click();
    expect(onSelectFile).toHaveBeenCalledWith("tools/tool_1.ts");
  });

  test("lists root files before directories", () => {
    const paths = [...Array.from({ length: 8 }, (_, i) => `tools/tool_${i}.ts`), "agent.ts"].sort();
    render(<FileNav paths={paths} currentFile={null} onSelectFile={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveTextContent(/^agent\.ts$/);
  });
});

describe("OwnershipBanner", () => {
  test("says the code is the user's, and links to GitHub sync where it exists", () => {
    const onSyncToGithub = vi.fn();
    render(<OwnershipBanner onSyncToGithub={onSyncToGithub} />);
    expect(screen.getByText(/it is yours to keep/)).toBeInTheDocument();
    screen.getByRole("button", { name: "Sync to GitHub" }).click();
    expect(onSyncToGithub).toHaveBeenCalledTimes(1);
  });

  test("offers no GitHub link where the platform has no GitHub App", () => {
    render(<OwnershipBanner />);
    expect(screen.getByText(/it is yours to keep/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync to GitHub" })).toBeNull();
    expect(screen.queryByText(/GitHub/)).toBeNull();
  });

  test("names no CLI command — GitHub sync is the one advertised way out", () => {
    const { container } = render(<OwnershipBanner onSyncToGithub={vi.fn()} />);
    expect(container.textContent).not.toMatch(/aai pull/);
  });
});
