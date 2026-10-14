// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings pane: a full page (not a dropdown) holding the project's own
// configuration — GitHub sync, the carrier webhook URLs and Delete project.
// A change here writes nothing into the conversation — the transcript is the
// user's. The sections run in a fixed order (Sync to GitHub when the platform
// has a GitHub App, Phone number, Danger zone). Secrets are their own pane
// (panes/secrets.test.tsx), and there is no "Work locally" card of `aai pull`
// commands because GitHub sync is the one way out of the studio the product
// points at.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { jsonResponse, renderWithClient, stubFetch } from "../_test-utils.ts";
import { SettingsPane } from "./settings.tsx";

/**
 * The card titles, in render order. Card titles are `.eyebrow` spans rather than
 * headings, and inside this pane every one of them is a section title.
 *
 * Read through the CLASS rather than by text. That was originally to disambiguate
 * the Database card's title from its own blurb, which named the pane it unlocked;
 * the card is gone, and reading by class is still right — a title is a position in
 * this list, and matching text would pass on a blurb that happened to repeat it.
 */
function cardTitles(): (string | null)[] {
  return [...document.querySelectorAll(".eyebrow")].map((el) => el.textContent);
}

/** The phone card's secrets read — the one request this pane makes itself. */
const SECRETS = { "/studio/projects/demo/secret": () => jsonResponse({ vars: [], pending: [] }) };

function renderPanel(onDeleteProject = vi.fn(), deployedSlug?: string) {
  renderWithClient(
    <SettingsPane
      project="demo"
      bearer="test-bearer"
      data={undefined}
      deployedSlug={deployedSlug}
      onDeleteProject={onDeleteProject}
      deleting={false}
    />,
  );
}

describe("SettingsPane", () => {
  test("the sections run in the order a project needs them", () => {
    // Getting the code out first, destruction last. With no GitHub App
    // configured (the stub answers every read with `{}`) the GitHub card
    // renders nothing — which is exactly what a self-hosted deploy sees.
    stubFetch(SECRETS);
    renderPanel();
    expect(cardTitles()).toEqual(["Phone number", "Danger zone"]);
  });

  test("secrets are only READ here — the phone card's signing-secret hints", async () => {
    // Editing secrets is the Secrets pane's; a write from this one would mean
    // a copy came back.
    const fetchMock = stubFetch(SECRETS);
    renderPanel();
    expect(screen.queryByText("Save secrets")).toBeNull();
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/secret"))).toBe(true),
    );
    const writes = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/secret") && (init?.method ?? "GET") !== "GET",
    );
    expect(writes).toEqual([]);
  });

  test("the phone card waits for a Publish, then shows each carrier's URL", () => {
    stubFetch(SECRETS);
    renderPanel(vi.fn());
    expect(screen.getByText("Publish this project to get its webhook URL.")).toBeInTheDocument();
  });

  test("a published project gets the Twilio and Telnyx webhook URLs", () => {
    stubFetch(SECRETS);
    renderPanel(vi.fn(), "demo-x7k2mq");
    const origin = window.location.origin;
    expect(screen.getByText(`${origin}/demo-x7k2mq/phone?carrier=twilio`)).toBeInTheDocument();
    expect(screen.getByText(`${origin}/demo-x7k2mq/phone?carrier=telnyx`)).toBeInTheDocument();
  });

  test("no aai pull anywhere — GitHub sync is the way out of the studio", () => {
    // The card came off deliberately, and a copy-pasted command list is the
    // kind of thing that comes back in a "helpful" follow-up. Assert on the
    // command rather than the card title: the title is a position in
    // `cardTitles()` above, while the command is what a reader would paste.
    stubFetch(SECRETS);
    renderPanel();
    expect(screen.queryByText(/aai pull/)).toBeNull();
    expect(screen.queryByText("Work locally")).toBeNull();
  });

  test("Delete project asks for confirmation before firing", () => {
    stubFetch(SECRETS);
    const onDeleteProject = vi.fn();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    renderPanel(onDeleteProject);
    fireEvent.click(screen.getByText("Delete project"));
    expect(onDeleteProject).not.toHaveBeenCalled();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fireEvent.click(screen.getByText("Delete project"));
    expect(onDeleteProject).toHaveBeenCalledTimes(1);
  });

  test("Delete project is available even on published projects", async () => {
    stubFetch(SECRETS);
    renderPanel();
    expect(await screen.findByText("Delete project")).toBeInTheDocument();
  });
});
