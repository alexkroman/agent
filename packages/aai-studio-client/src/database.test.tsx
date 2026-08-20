// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Database pane's table viewer.
//
// Four things matter here, and each is a way the pane could give a WRONG
// answer rather than a plain one: the environment travels with every read (a
// row written by the preview is not in production, and a pane that mixed the
// two would be worse than no pane); a table's rows are keyed by the table, so
// switching cannot leave the previous table's rows under a new heading; NULL
// is rendered as a value, since a text column may legitimately hold the empty
// string; and "nothing to read" is one sentence rather than a raw 404.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { button, jsonResponse, renderWithClient, stubFetch } from "./_test-utils.ts";
import { DatabasePane } from "./database.tsx";

const TABLES = "/studio/projects/demo/database/tables";
const ROWS = "/studio/projects/demo/database/rows";

function tableListing() {
  return jsonResponse({
    environment: "production",
    slug: "demo",
    tables: [
      { schema: "public", name: "notes", rows: 2 },
      { schema: "public", name: "people", rows: 0 },
    ],
  });
}

function renderPane() {
  renderWithClient(<DatabasePane bearer="sk-test" project="demo" />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DatabasePane", () => {
  test("lists the tables and opens the first one", async () => {
    const fetchMock = stubFetch({
      [`GET ${TABLES}`]: tableListing,
      [`GET ${ROWS}`]: () =>
        jsonResponse({ columns: ["id", "body"], rows: [["1", "hello"]], total: 1 }),
    });
    renderPane();

    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    expect(screen.getByText("id")).toBeTruthy();
    // The rows read names the table it is for — the pane never asks the
    // server to pick one.
    const rowsCall = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), window.location.origin))
      .find((url) => url.pathname === ROWS);
    expect(rowsCall?.searchParams.get("table")).toBe("notes");
    expect(rowsCall?.searchParams.get("schema")).toBe("public");
    expect(rowsCall?.searchParams.get("environment")).toBe("production");
  });

  test("every read carries the environment, and switching re-reads", async () => {
    // Production and preview are separate agents with separate schemas, so
    // "my tool saved nothing" and "my tool saved it in the preview" are the
    // two answers this distinguishes.
    const fetchMock = stubFetch({
      [`GET ${TABLES}`]: () => jsonResponse({ environment: "preview", slug: "demo", tables: [] }),
    });
    renderPane();
    await waitFor(() => expect(screen.getByText(/no tables yet/)).toBeTruthy());

    fireEvent.click(button("Preview"));
    await waitFor(() => {
      const environments = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), window.location.origin))
        .filter((url) => url.pathname === TABLES)
        .map((url) => url.searchParams.get("environment"));
      expect(environments).toEqual(["production", "preview"]);
    });
  });

  test("picking another table re-reads for THAT table", async () => {
    // The rows query is keyed by the table, so the previous table's rows can
    // never sit under a new heading while the next read is in flight.
    const fetchMock = stubFetch({
      [`GET ${TABLES}`]: tableListing,
      [`GET ${ROWS}`]: () => jsonResponse({ columns: ["id"], rows: [["1"]], total: 1 }),
    });
    renderPane();
    await waitFor(() => expect(screen.getByText("id")).toBeTruthy());

    fireEvent.click(button(/^people/));
    await waitFor(() => {
      const tables = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), window.location.origin))
        .filter((url) => url.pathname === ROWS)
        .map((url) => url.searchParams.get("table"));
      expect(tables).toEqual(["notes", "people"]);
    });
  });

  test("renders NULL as a value, not as an empty cell", async () => {
    // A text column may hold the empty string, and the two must not look
    // identical — that is the one distinction a data viewer owes.
    stubFetch({
      [`GET ${TABLES}`]: tableListing,
      [`GET ${ROWS}`]: () => jsonResponse({ columns: ["body"], rows: [[null], [""]], total: 2 }),
    });
    renderPane();
    await waitFor(() => expect(screen.getByText("NULL")).toBeTruthy());
  });

  test("an environment with no database says so rather than showing a 404", async () => {
    // The server answers the same 404 for an undeployed environment, a
    // database switched off, and a slug this caller does not own — see
    // studio-database-browse.ts for why it does not distinguish them.
    stubFetch({
      [`GET ${TABLES}`]: () => jsonResponse({ error: "No database to read" }, 404),
    });
    renderPane();
    await waitFor(() => expect(screen.getByText(/No database to read here yet/)).toBeTruthy());
  });

  test("names the agent that answered", async () => {
    // Which deployed agent's rows these are is the pane's most load-bearing
    // fact, so it is on screen rather than implied by the picker.
    stubFetch({
      [`GET ${TABLES}`]: () =>
        jsonResponse({ environment: "production", slug: "demo-x7k2mq", tables: [] }),
    });
    renderPane();
    await waitFor(() => expect(screen.getByText("demo-x7k2mq")).toBeTruthy());
  });

  test("pages through a table larger than one read", async () => {
    stubFetch({
      [`GET ${TABLES}`]: () =>
        jsonResponse({
          environment: "production",
          slug: "demo",
          tables: [{ schema: "public", name: "notes", rows: 120 }],
        }),
      [`GET ${ROWS}`]: () => jsonResponse({ columns: ["id"], rows: [["1"]], total: 120 }),
    });
    renderPane();

    await waitFor(() => expect(screen.getByText(/of 120/)).toBeTruthy());
    expect(button("Previous").disabled).toBe(true);
    fireEvent.click(button("Next"));
    await waitFor(() => expect(screen.getByText(/^51–/)).toBeTruthy());
    expect(button("Previous").disabled).toBe(false);
    fireEvent.click(button("Previous"));
    await waitFor(() => expect(button("Previous").disabled).toBe(true));
  });
});
