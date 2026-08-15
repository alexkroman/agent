// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// Top bar wiring: brand → home, the project name label, and the Publish
// menu states.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { agentUrl } from "./platform-origin.ts";
import { PublishMenu, TopBar } from "./top-bar.tsx";

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
  onToggleAccount: noop,
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

  test("Publish reads as a closed toggle by default", () => {
    render(<TopBar {...barProps} />);
    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish.getAttribute("aria-expanded")).toBe("false");
    expect(publish.getAttribute("aria-haspopup")).toBe("dialog");
    expect(publish.getAttribute("aria-controls")).toBeNull();
  });

  test("an open menu shows on the button, so pressing again reads as 'hide'", () => {
    // The pressed affordance is the panel's only dismiss cue now — the menu
    // has no Close button.
    render(<TopBar {...barProps} publishOpen={true} />);
    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish.getAttribute("aria-expanded")).toBe("true");
    expect(publish.getAttribute("aria-controls")).toBe("publish-menu");
    expect(publish.getAttribute("title")).toContain("Hide");
    expect(publish.className).toContain("bg-indigo-hover");
  });

  test("the toggle fires on press whether the menu is open or closed", () => {
    const onTogglePublish = vi.fn();
    const { rerender } = render(<TopBar {...barProps} onTogglePublish={onTogglePublish} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    rerender(<TopBar {...barProps} publishOpen={true} onTogglePublish={onTogglePublish} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(onTogglePublish).toHaveBeenCalledTimes(2);
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

  // Account-scoped, so unlike the pane switcher it is present with no project
  // open — the home screen is where a wrong key most needs replacing.
  test.each(["demo", null])("Account toggles the account panel with project=%s", (project) => {
    const onToggleAccount = vi.fn();
    render(<TopBar {...barProps} project={project} onToggleAccount={onToggleAccount} />);
    const toggle = screen.getByRole("button", { name: "Account" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggleAccount).toHaveBeenCalled();
  });

  test("an open account panel marks the toggle expanded and owning it", () => {
    render(<TopBar {...barProps} accountOpen />);
    const toggle = screen.getByRole("button", { name: "Account" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("account-menu");
  });
});

describe("PublishMenu", () => {
  const menuProps = { busy: false, onPublish: noop, onClose: noop };

  test("renders nothing while closed", () => {
    const { container } = render(<PublishMenu {...menuProps} open={false} />);
    expect(container.innerHTML).toBe("");
  });

  test("open: Publish triggers the deploy", () => {
    const onPublish = vi.fn();
    render(<PublishMenu {...menuProps} open={true} onPublish={onPublish} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(onPublish).toHaveBeenCalled();
  });

  test("no Close button — the top bar's pressed toggle is the dismiss control", () => {
    render(<PublishMenu {...menuProps} open={true} />);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  test("Escape dismisses", () => {
    const onClose = vi.fn();
    render(<PublishMenu {...menuProps} open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("a click away dismisses; one inside the panel does not", () => {
    const onClose = vi.fn();
    render(<PublishMenu {...menuProps} open={true} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("pressing the top bar's toggle does not double-fire the dismiss", () => {
    // Outside-click would close what the toggle is about to reopen, so the
    // toggle is exempt and `onTogglePublish` stays the single owner.
    const onClose = vi.fn();
    render(
      <>
        <TopBar {...barProps} publishOpen={true} />
        <PublishMenu {...menuProps} open={true} onClose={onClose} />
      </>,
    );
    const toggle = document.querySelector("[data-publish-toggle]");
    expect(toggle).not.toBeNull();
    fireEvent.pointerDown(toggle as Element);
    expect(onClose).not.toHaveBeenCalled();
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

  test("a successful deploy leads with the live URL and folds the CLI output away", () => {
    // The transcript repeats the URL twice more and also lands in the chat,
    // so it is a disclosure rather than a third copy of the same line.
    const { container } = render(
      <PublishMenu {...menuProps} open={true} output="deployed" deployedSlug="my-agent" />,
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe(agentUrl("my-agent"));
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(details?.textContent).toContain("deployed");
  });

  test("the panel names itself once — no eyebrow repeating the toggle's label", () => {
    render(<PublishMenu {...menuProps} open={true} />);
    // Exactly one thing in the panel says "Publish": the action button.
    expect(screen.getAllByText("Publish")).toHaveLength(1);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Publish");
  });
});
