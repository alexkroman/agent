// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Workflows pane — the page frame around the card that does the reading.
//
// The card's own behaviour (the brokered read, the preview fallback, Stop on a
// live run) is covered by workflows-card.test.tsx. What is worth pinning here
// is the thing the promotion out of Settings could silently undo: the pane
// passes BOTH slugs through, so a project with a preview and no publish still
// has something to show.

import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, renderWithClient, stubFetch } from "./_test-utils.ts";
import { WorkflowsPane } from "./workflows.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkflowsPane", () => {
  test("reads the published agent when there is one", async () => {
    const fetchMock = stubFetch({
      "GET /demo/workflows": () => jsonResponse({ workflows: [] }),
    });
    renderWithClient(<WorkflowsPane deployedSlug="demo" previewSlug="demo-preview" />);

    await waitFor(() => expect(screen.getByText(/declares no workflows/)).toBeTruthy());
    // Absolute: the card reads through the SDK's client, which resolves
    // against the agent's base URL.
    const paths = fetchMock.mock.calls.map(
      ([input]) => new URL(String(input), window.location.origin).pathname,
    );
    expect(paths).toEqual(["/demo/workflows"]);
  });

  test("falls back to the preview agent before a first publish", async () => {
    // The usual state: a project has a preview long before production, and a
    // pane that showed nothing until then would be empty for most of a
    // project's life.
    stubFetch({ "GET /demo-preview/workflows": () => jsonResponse({ workflows: [] }) });
    renderWithClient(<WorkflowsPane previewSlug="demo-preview" />);
    await waitFor(() => expect(screen.getByText(/preview/)).toBeTruthy());
  });

  test("says what the pane is for when neither slug exists", () => {
    renderWithClient(<WorkflowsPane />);
    expect(screen.getByText(/Publish this project/)).toBeTruthy();
    // Twice: the pane's own heading, and the card's eyebrow under it.
    expect(screen.getAllByText("Workflows").length).toBe(2);
  });
});
