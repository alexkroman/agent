// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings pane: a full page (not a dropdown) holding the project's own
// configuration — GitHub sync and Delete project.
// A change here writes nothing into the conversation — the transcript is the
// user's. Every section works with no published slug, and they run in a fixed
// order (Sync to GitHub when the platform has a GitHub App, Danger zone).
// Secrets used to sit between them and are their own pane now
// (panes/secrets.test.tsx); the Database switch is gone with the per-app
// databases it turned on; and the "Work locally" card of `aai pull` commands
// is gone because GitHub sync is the one way out of the studio the product
// points at.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithClient, stubFetch } from "../_test-utils.ts";
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
    // Getting the code out first, destruction last: GitHub sync, then Delete
    // project at the bottom. With no GitHub App configured (the stub answers
    // every read with `{}`) the GitHub card renders nothing, so Danger zone is
    // the whole pane — which is exactly what a self-hosted deploy sees.
    //
    // FIVE subjects left this pane and the list is what says so. The carrier
    // webhook URLs and the workflow runs are both about a deployed agent — how
    // something calls it, and what it is still doing — which is the API and
    // Workflows panes' subject. Secrets left for a different reason: a
    // textarea of KEY=value lines was the whole UI for the configuration
    // people come back to most. The Database switch left because there are no
    // per-app databases to switch on: durable runs, the run journal and session
    // state are all the platform's. And the "Work locally" card — install /
    // `aai login` / `aai pull` / `aai dev` with copy buttons — left because it
    // was a second answer to the question the GitHub card answers, and the
    // product points at GitHub sync. Everything remaining works from the moment
    // a project exists, which is what makes "nothing here gates on a deploy"
    // literally true rather than nearly.
    stubFetch({});
    renderPanel();
    expect(cardTitles()).toEqual(["Danger zone"]);
  });

  test("no secrets here — the pane neither reads nor writes the secret route", () => {
    // The whole subject moved to its own pane, so a request to that route from
    // this one would mean a copy came back.
    const fetchMock = stubFetch({});
    renderPanel();
    expect(screen.queryByText("Save secrets")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/secret"))).toBe(false);
  });

  test("no aai pull anywhere — GitHub sync is the way out of the studio", () => {
    // The card came off deliberately, and a copy-pasted command list is the
    // kind of thing that comes back in a "helpful" follow-up. Assert on the
    // command rather than the card title: the title is a position in
    // `cardTitles()` above, while the command is what a reader would paste.
    stubFetch({});
    renderPanel();
    expect(screen.queryByText(/aai pull/)).toBeNull();
    expect(screen.queryByText("Work locally")).toBeNull();
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
