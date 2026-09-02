// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings pane: a full page (not a dropdown) holding the project's own
// configuration — the CLI round-trip and Delete project.
// A change here writes nothing into the conversation — the transcript is the
// user's. Every section works with no published slug, and they run in a fixed
// order (Work locally, Danger zone). Secrets used to sit between them and are
// their own pane now (secrets.test.tsx); the Database switch is gone with the
// per-app databases it turned on.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithClient, stubFetch } from "./_test-utils.ts";
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

function renderPanel(onDeleteProject = vi.fn()) {
  renderWithClient(
    <SettingsPane
      project="demo"
      bearer="test-bearer"
      data={undefined}
      onDeleteProject={onDeleteProject}
      deleting={false}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPane", () => {
  test("the sections run in the order a project needs them", () => {
    // Setting up first, destruction last: the CLI round-trip, then Delete project
    // at the bottom.
    //
    // FOUR subjects left this pane and the list is what says so. The carrier
    // webhook URLs and the workflow runs are both about a deployed agent — how
    // something calls it, and what it is still doing — which is the API and
    // Workflows panes' subject. Secrets left for a different reason: a
    // textarea of KEY=value lines was the whole UI for the configuration
    // people come back to most. The Database switch left because there are no
    // per-app databases to switch on: durable runs, the run journal and session
    // state are all the platform's. Everything remaining works from the moment a
    // project exists, which is what makes "nothing here gates on a deploy"
    // literally true rather than nearly.
    stubFetch({});
    renderPanel();
    expect(cardTitles()).toEqual(["Work locally", "Danger zone"]);
  });

  test("no secrets here — the pane neither reads nor writes the secret route", () => {
    // The whole subject moved to its own pane, so a request to that route from
    // this one would mean a copy came back.
    const fetchMock = stubFetch({});
    renderPanel();
    expect(screen.queryByText("Save secrets")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/secret"))).toBe(false);
  });

  test("the CLI section renders with no published slug — pulling needs no deploy", () => {
    stubFetch({});
    renderPanel();
    expect(screen.getByText("aai pull demo")).toBeTruthy();
    expect(screen.getByText("Work locally")).toBeTruthy();
  });

  test("Delete project asks for confirmation before firing", () => {
    stubFetch({});
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
    stubFetch({});
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("Delete project")).toBeTruthy();
    });
  });
});
