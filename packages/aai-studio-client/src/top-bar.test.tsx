// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// Top bar wiring: brand → home, the project name label, and the Publish
// menu states.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { button } from "./_test-utils.ts";
import { agentUrl } from "./platform-origin.ts";
import { PublishMenu, TopBar } from "./top-bar.tsx";

const noop = (): void => undefined;

/** Every pane label, in the order the segmented control renders them. */
const PANE_LABELS = ["UI", "API", "Workflows", "Code", "Logs", "Secrets", "Settings"];

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

  test("no project → no name label and no pane switcher", () => {
    render(<TopBar {...barProps} project={null} />);
    expect(screen.queryByText("demo")).toBeNull();
    expect(screen.queryByRole("button", { name: "UI" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  // The UI tab's LABEL and its id deliberately differ: `preview` is the
  // platform's word for the auto-deployed agent this pane frames, and "UI" is
  // what the pane offers a person.
  test.each([
    ["Code", "code"],
    ["Settings", "settings"],
    ["UI", "preview"],
    ["API", "docs"],
    ["Workflows", "workflows"],
    ["Secrets", "secrets"],
  ])("the switcher moves to the %s pane", (label, id) => {
    const onSelectTab = vi.fn();
    render(<TopBar {...barProps} onSelectTab={onSelectTab} />);
    fireEvent.click(button(label));
    expect(onSelectTab).toHaveBeenCalledWith(id);
  });

  // The switcher's order is a product decision with nothing else holding it:
  // the panes are peers, so a reshuffle of TABS is invisible to every other
  // assertion here. UI leads API because the client someone can actually use
  // comes before the contract it exercises.
  test("the switcher runs UI before API, then the rest in order", () => {
    render(<TopBar {...barProps} />);
    const rendered = screen
      .getAllByRole("button")
      .map((el) => el.textContent ?? "")
      .filter((label) => PANE_LABELS.includes(label));
    expect(rendered).toEqual(PANE_LABELS);
  });

  /**
   * Every pane, unconditionally — asserted because it used to be conditional.
   *
   * `databaseEnabled` hid **Database** and **Workflows**: a project with no
   * database had nothing to browse, and Workflows rode along because without one a
   * guest ran the LOCAL workflow world, whose queue is in memory and whose data
   * directory is per-process, so the pane would have listed runs that die with the
   * sandbox. There is no Database pane now, and a durable run no longer needs the
   * project to have a database — the world is the platform's — so the gate is gone
   * and this pins the absence.
   */
  test("offers every pane with no opt-in, and no Database tab at all", () => {
    render(<TopBar {...barProps} />);
    expect(screen.queryByRole("button", { name: "Database" })).toBeNull();
    for (const label of ["UI", "API", "Workflows", "Code", "Logs", "Secrets", "Settings"]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
  });

  test("the open pane is the current one", () => {
    render(<TopBar {...barProps} tab="settings" />);
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "UI" }).getAttribute("aria-current")).toBeNull();
  });

  test("Publish locks until there is a build; the project panes stay reachable", () => {
    // Settings must never gate on a build or a deploy — the pane holds the
    // Delete project button, which has to work before anything is published —
    // and neither must Secrets: a provider key is what the FIRST build needs.
    render(<TopBar {...barProps} hasBuild={false} />);
    expect(button("Publish").disabled).toBe(true);
    expect(button("Settings").disabled).toBe(false);
    expect(button("Secrets").disabled).toBe(false);
  });

  test("Publish locks while a chat turn streams, even with a build", () => {
    render(<TopBar {...barProps} chatBusy={true} />);
    const publish = button("Publish");
    expect(publish.disabled).toBe(true);
    expect(publish.getAttribute("title")).toContain("finishes its turn");
  });

  test("Publish unlocks once the turn settles", () => {
    render(<TopBar {...barProps} chatBusy={false} />);
    expect(button("Publish").disabled).toBe(false);
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
    expect(button("Publishing…").disabled).toBe(true);
  });

  test("a streaming chat turn disables Publish inside an already-open menu", () => {
    render(<PublishMenu {...menuProps} open={true} chatBusy={true} />);
    const publish = button("Publish");
    expect(publish.disabled).toBe(true);
    expect(publish.getAttribute("title")).toContain("finishes its turn");
  });

  test("an error renders as CLI output and suppresses the live link", () => {
    render(<PublishMenu {...menuProps} open={true} error="build failed" deployedSlug="my-agent" />);
    expect(screen.getByText("build failed")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("a successful deploy leads with the live URL and folds the CLI output away", () => {
    // The transcript repeats the URL twice more, so it is a disclosure rather
    // than a third copy of the same line.
    const { container } = render(
      <PublishMenu {...menuProps} open={true} output="deployed" deployedSlug="my-agent" />,
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe(agentUrl("my-agent"));
    // `querySelector("details")` is already typed HTMLDetailsElement | null by
    // the tag map, so `.open` needs no cast — only the null check the cast
    // was standing in for.
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("deployed");
  });

  test("the panel names itself once — no eyebrow repeating the toggle's label", () => {
    render(<PublishMenu {...menuProps} open={true} />);
    // Exactly one thing in the panel says "Publish": the action button.
    expect(screen.getAllByText("Publish")).toHaveLength(1);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Publish");
  });
});
