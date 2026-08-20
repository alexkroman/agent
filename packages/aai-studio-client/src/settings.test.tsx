// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings pane: a full page (not a dropdown) holding the project's own
// configuration — the CLI round-trip, the Database switch, and Delete project.
// A change here writes nothing into the conversation — the transcript is the
// user's. Every section works with no published slug, and they run in a fixed
// order (Work locally, Database, Danger zone). Secrets used to sit between the
// last two and are their own pane now (secrets.test.tsx).

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, renderWithClient, stubFetch } from "./_test-utils.ts";
import { SettingsPane } from "./settings.tsx";

/**
 * The pane also renders the Database card, which reads its own state on
 * mount. Spread into every route table here so a test that only cares about
 * this pane's own sections doesn't have to know about it (the card itself is
 * covered by database-card.test.tsx).
 */
const DATABASE_STATE = {
  "GET /studio/projects/demo/database": () =>
    jsonResponse({ enabled: false, configured: true, environments: [] }),
};

function renderPanel(onDeleteProject = vi.fn()) {
  renderWithClient(
    <SettingsPane
      bearer="sk-test"
      project="demo"
      onDeleteProject={onDeleteProject}
      deleting={false}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPane", () => {
  test("the sections run in the order a project needs them", async () => {
    // Setting up first, destruction last: the CLI round-trip, the Database
    // switch, and Delete project at the bottom.
    //
    // Three subjects LEFT this pane and the list is what says so. The carrier
    // webhook URLs and the workflow runs are both about a deployed agent — how
    // something calls it, and what it is still doing — which is the API and
    // Workflows panes' subject. Secrets left for a different reason: a
    // textarea of KEY=value lines was the whole UI for the configuration
    // people come back to most. Everything remaining works from the moment a
    // project exists, which is what makes "nothing here gates on a deploy"
    // literally true rather than nearly.
    stubFetch({ ...DATABASE_STATE });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Database")).toBeTruthy());
    // Card titles are eyebrow spans rather than headings, and inside this
    // pane every one of them is a section title.
    const titles = [...document.querySelectorAll(".eyebrow")].map((el) => el.textContent);
    expect(titles).toEqual(["Work locally", "Database", "Danger zone"]);
  });

  test("no secrets here — the pane neither reads nor writes the secret route", async () => {
    // The whole subject moved to its own pane, so a request to that route from
    // this one would mean a copy came back.
    const fetchMock = stubFetch({ ...DATABASE_STATE });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Database")).toBeTruthy());
    expect(screen.queryByText("Save secrets")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/secret"))).toBe(false);
  });

  test("the CLI section renders with no published slug — pulling needs no deploy", () => {
    stubFetch({ ...DATABASE_STATE });
    renderPanel();
    expect(screen.getByText("aai pull demo")).toBeTruthy();
    expect(screen.getByText("Work locally")).toBeTruthy();
  });

  test("Delete project asks for confirmation before firing", () => {
    stubFetch({ ...DATABASE_STATE });
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
    stubFetch({ ...DATABASE_STATE });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("Delete project")).toBeTruthy();
    });
  });
});
