// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// Top bar wiring: brand → home, the project name label, and the Publish
// menu states.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { agentUrl, PublishMenu, TopBar } from "./top-bar.tsx";

afterEach(cleanup);

const noop = (): void => undefined;

const barProps = {
  project: "demo" as string | null,
  tab: "preview" as const,
  hasBuild: true,
  onGoHome: noop,
  onSelectTab: noop,
  onLogOut: noop,
  onTogglePublish: noop,
};

describe("TopBar", () => {
  test("the brand is a button back to the hero home", () => {
    const onGoHome = vi.fn();
    render(<TopBar {...barProps} onGoHome={onGoHome} />);
    fireEvent.click(screen.getByTitle("Home"));
    expect(onGoHome).toHaveBeenCalled();
  });

  test("shows the open project's name, and no switcher", () => {
    render(<TopBar {...barProps} />);
    expect(screen.getByText("demo")).toBeDefined();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  test("no project → no name label and no Preview/Code/Settings switcher", () => {
    render(<TopBar {...barProps} project={null} />);
    expect(screen.queryByText("demo")).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  test("the switcher moves between all three panes", () => {
    const onSelectTab = vi.fn();
    render(<TopBar {...barProps} onSelectTab={onSelectTab} />);
    for (const [label, id] of [
      ["Code", "code"],
      ["Settings", "settings"],
      ["Preview", "preview"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: label as string }));
      expect(onSelectTab).toHaveBeenCalledWith(id);
    }
  });

  test("the open pane is the current one", () => {
    render(<TopBar {...barProps} tab="settings" />);
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-current")).toBeNull();
  });

  test("Publish locks until there is a build; Settings stays reachable", () => {
    // Settings must never gate on a build or a deploy — the pane holds the
    // Delete project button, which has to work before anything is published.
    render(<TopBar {...barProps} hasBuild={false} />);
    const publish = screen.getByRole("button", { name: "Publish" });
    const settings = screen.getByRole("button", { name: "Settings" });
    expect((publish as HTMLButtonElement).disabled).toBe(true);
    expect((settings as HTMLButtonElement).disabled).toBe(false);
  });

  test("Publish locks while a chat turn streams, even with a build", () => {
    render(<TopBar {...barProps} chatBusy={true} />);
    const publish = screen.getByRole("button", { name: "Publish" });
    expect((publish as HTMLButtonElement).disabled).toBe(true);
    expect(publish.getAttribute("title")).toContain("finishes its turn");
  });

  test("Publish unlocks once the turn settles", () => {
    render(<TopBar {...barProps} chatBusy={false} />);
    const publish = screen.getByRole("button", { name: "Publish" });
    expect((publish as HTMLButtonElement).disabled).toBe(false);
  });

  test("a deployed slug shows the production link", () => {
    render(<TopBar {...barProps} deployedSlug="my-agent" />);
    // The production URL is a plain link that opens in a new tab.
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(agentUrl("my-agent"));
    expect(link.getAttribute("target")).toBe("_blank");
  });

  test("Log out is wired to the sign-out handler", () => {
    const onLogOut = vi.fn();
    render(<TopBar {...barProps} onLogOut={onLogOut} />);
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(onLogOut).toHaveBeenCalled();
  });
});

describe("PublishMenu", () => {
  const menuProps = { busy: false, onPublish: noop, onClose: noop };

  test("renders nothing while closed", () => {
    const { container } = render(<PublishMenu {...menuProps} open={false} />);
    expect(container.innerHTML).toBe("");
  });

  test("open: Publish triggers the deploy, Close dismisses", () => {
    const onPublish = vi.fn();
    const onClose = vi.fn();
    render(<PublishMenu open={true} busy={false} onPublish={onPublish} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(onPublish).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  test("busy shows progress and disables the button", () => {
    render(<PublishMenu {...menuProps} open={true} busy={true} />);
    const button = screen.getByRole("button", { name: "Publishing…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test("a streaming chat turn disables Publish inside an already-open menu", () => {
    render(<PublishMenu {...menuProps} open={true} chatBusy={true} />);
    const button = screen.getByRole("button", { name: "Publish" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("finishes its turn");
  });

  test("an error renders as CLI output and suppresses the live link", () => {
    render(<PublishMenu {...menuProps} open={true} error="build failed" deployedSlug="my-agent" />);
    expect(screen.getByText("build failed")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("a successful deploy shows output and the live URL", () => {
    render(<PublishMenu {...menuProps} open={true} output="deployed" deployedSlug="my-agent" />);
    expect(screen.getByText("deployed")).toBeDefined();
    expect(screen.getByRole("link").getAttribute("href")).toBe(agentUrl("my-agent"));
  });
});
