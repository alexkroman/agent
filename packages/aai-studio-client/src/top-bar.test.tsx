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
  settingsOpen: false,
  onGoHome: noop,
  onSelectTab: noop,
  onLogOut: noop,
  onTogglePublish: noop,
  onToggleSettings: noop,
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

  test("no project → no name label", () => {
    render(<TopBar {...barProps} project={null} />);
    expect(screen.queryByText("demo")).toBeNull();
  });

  test("tab buttons switch between Preview and Code", () => {
    const onSelectTab = vi.fn();
    render(<TopBar {...barProps} onSelectTab={onSelectTab} />);
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(onSelectTab).toHaveBeenCalledWith("code");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onSelectTab).toHaveBeenCalledWith("preview");
  });

  test("Publish and Settings lock until there is a build / a deploy", () => {
    render(<TopBar {...barProps} hasBuild={false} />);
    const publish = screen.getByRole("button", { name: "Publish" });
    const settings = screen.getByRole("button", { name: "Settings" });
    expect((publish as HTMLButtonElement).disabled).toBe(true);
    expect((settings as HTMLButtonElement).disabled).toBe(true);
  });

  test("a deployed slug shows the production link and unlocks Settings", () => {
    const onToggleSettings = vi.fn();
    render(<TopBar {...barProps} deployedSlug="my-agent" onToggleSettings={onToggleSettings} />);
    // The production URL is a plain link that opens in a new tab.
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(agentUrl("my-agent"));
    expect(link.getAttribute("target")).toBe("_blank");
    const settings = screen.getByRole("button", { name: "Settings" });
    expect((settings as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(settings);
    expect(onToggleSettings).toHaveBeenCalled();
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
