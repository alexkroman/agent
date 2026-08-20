// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The API pane: this project's own HTTP surface, read from the running agent.
//
// What matters here is that the workflow half is GENERATED rather than written
// — the request bodies carry the field names the deployed agent declares, so a
// snippet is current by construction — that it reads the AGENT's brokered API
// rather than a studio route, that it falls back to the preview agent and says
// so, and that the carrier webhook URLs live on this pane now (they are how
// something CALLS this agent, which is this pane's subject).
//
// And that each half is offered only to the agents it is TRUE for: no carrier
// webhook for a workflow app (`page: "static"` defaults telephony off, so a
// number pointed at one answers and hangs up), and no workflow routes for an
// agent that declares no workflow (there is no name to put in `{ workflow }`).
// Both are read off the agent, so both are asserted through a stubbed answer
// from it rather than off the project's stored kind.

import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, renderWithClient, stubFetch } from "./_test-utils.ts";
import { DocsPane } from "./docs.tsx";

const SECRETS = "/studio/projects/demo/secret";

/** The declared workflows one agent answers with, schema included. */
function listing(secretNames: string[] = []) {
  return {
    "GET /demo/workflows": () =>
      jsonResponse({
        workflows: [
          {
            name: "digest",
            description: "Research a topic overnight",
            inputSchema: { type: "object", properties: { topic: { type: "string" } } },
          },
        ],
      }),
    [`GET ${SECRETS}`]: () => jsonResponse({ vars: secretNames, pending: [] }),
    "GET /demo/client-config": () => jsonResponse({ name: "Demo", page: "voice" }),
  };
}

function renderPane(props: { deployedSlug?: string; previewSlug?: string } = {}) {
  renderWithClient(<DocsPane bearer="sk-test" project="demo" {...props} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocsPane", () => {
  test("asks for a publish or an edit when nothing is deployed", () => {
    // With no slug there is no base URL, so every snippet would be a
    // placeholder somebody could paste and wonder about.
    renderPane();
    expect(screen.getByText(/Publish this project/)).toBeTruthy();
  });

  test("generates the request body from the agent's own input schema", async () => {
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });

    // Both snippets carry it — the `curl` and the SDK call — which is why
    // this asks for all of them rather than one.
    await waitFor(() => expect(screen.getAllByText(/"topic":"<topic>"/).length).toBe(2));
    // The base URL is this page's origin plus the slug, which is what makes
    // the snippet runnable rather than illustrative.
    const origin = window.location.origin;
    expect(screen.getByText(new RegExp(`curl -X POST ${origin}/demo/workflows/runs`))).toBeTruthy();
  });

  test("reads the AGENT's own API, not a studio route", async () => {
    const fetchMock = stubFetch(listing());
    renderPane({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText("digest")).toBeTruthy());
    // The agent's own path, not a studio route. The listing URL is absolute
    // (the SDK client resolves against the agent's base URL) while the studio
    // reads beside it are relative, so both are read as paths.
    const paths = fetchMock.mock.calls.map(
      ([input]) => new URL(String(input), window.location.origin).pathname,
    );
    expect(paths).toContain("/demo/workflows");
  });

  test("falls back to the PREVIEW agent, and says which one it is showing", async () => {
    stubFetch({
      "GET /demo-preview/workflows": () => jsonResponse({ workflows: [] }),
      "GET /demo-preview/client-config": () => jsonResponse({ page: "voice" }),
      [`GET ${SECRETS}`]: () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPane({ previewSlug: "demo-preview" });
    // A project has a preview long before a first publish, so documenting
    // nothing until then would leave the pane empty for its whole early life.
    await waitFor(() => expect(screen.getByText(/preview agent/)).toBeTruthy());
  });

  test("names the bearer only when the agent's env closes the API", async () => {
    stubFetch(listing(["AAI_WORKFLOW_API_TOKEN"]));
    renderPane({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getAllByText(/Authorization: Bearer/).length).toBeTruthy());
  });

  test("an agent that declares no workflows says so rather than showing nothing", async () => {
    stubFetch({
      "GET /demo/workflows": () => jsonResponse({ workflows: [] }),
      "GET /demo/client-config": () => jsonResponse({ page: "voice" }),
      [`GET ${SECRETS}`]: () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPane({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByText(/declares no workflows/)).toBeTruthy());
  });

  test("and shows it none of the workflow API", async () => {
    // The routes exist for this agent — the platform proxies them for every
    // one — and every call through them needs a workflow name it has none of.
    // A table of twelve of those reads as a feature the reader is failing to
    // use, which is the opposite of what this pane is for.
    stubFetch({
      "GET /demo/workflows": () => jsonResponse({ workflows: [] }),
      "GET /demo/client-config": () => jsonResponse({ page: "voice" }),
      [`GET ${SECRETS}`]: () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPane({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByText(/declares no workflows/)).toBeTruthy());
    expect(screen.queryByText(/Running a workflow/)).toBeNull();
    expect(screen.queryByText(`${window.location.origin}/demo/workflows/runs`)).toBeNull();
  });

  test("a workflow app is not offered the carrier webhook", async () => {
    // `page: "static"` declines `/websocket` and defaults telephony OFF, so
    // the whole phone integration is a URL that answers a call and hangs up.
    // Twilio and Telnyx are the two the platform emits documents for, so
    // neither carrier's name belongs on a workflow app's pane.
    stubFetch({
      "GET /demo/workflows": () =>
        jsonResponse({ workflows: [{ name: "digest", inputSchema: undefined }] }),
      "GET /demo/client-config": () => jsonResponse({ name: "Desk", page: "static" }),
      [`GET ${SECRETS}`]: () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPane({ deployedSlug: "demo" });
    // The workflow half is what this agent IS, so it is on screen — which is
    // what makes the absences below the pane's judgement rather than a pane
    // that failed to render.
    await waitFor(() => expect(screen.getByText("digest")).toBeTruthy());
    expect(screen.queryByText("Twilio")).toBeNull();
    expect(screen.queryByText("Telnyx")).toBeNull();
    expect(screen.queryByText(`${window.location.origin}/demo/phone`)).toBeNull();
  });

  test("a voice agent still gets all of it", async () => {
    // The negative tests above pass for a pane that renders nothing, so the
    // positive one is what says the rows are gated rather than gone.
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });
    const origin = window.location.origin;
    // The URL alone: each row's method sits in a `<span>` of its own, so the
    // matchable text on the row is the URL.
    await waitFor(() => expect(screen.getByText(`${origin}/demo/phone`)).toBeTruthy());
    expect(screen.getByText(`${origin}/demo/client-config`)).toBeTruthy();
    expect(screen.getByText(`${origin}/demo/workflows`)).toBeTruthy();
    expect(screen.getByText("Twilio")).toBeTruthy();
  });

  test("quotes the agent's own sentence when the listing cannot be read", async () => {
    // A 503 while a sandbox boots and a 404 for an agent with no workflow API
    // read very differently, and that text is the whole difference.
    stubFetch({
      "GET /demo/workflows": () => jsonResponse({ error: "Agent is starting" }, 503),
      "GET /demo/client-config": () => jsonResponse({ page: "voice" }),
      [`GET ${SECRETS}`]: () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPane({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByText(/Agent is starting/)).toBeTruthy());
  });

  test("asks the AGENT whether it is a page or a voice session", async () => {
    // The project's stored `kind` is the cheap answer and the wrong one: it
    // selects the coding agent's prompt and is explicitly a default rather
    // than a cage, so it can disagree with what is deployed. This cannot.
    stubFetch({
      "GET /demo/workflows": () => jsonResponse({ workflows: [] }),
      "GET /demo/client-config": () => jsonResponse({ name: "Desk", page: "static" }),
      [`GET ${SECRETS}`]: () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPane({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByText(/serves a page rather than/)).toBeTruthy());
  });

  test("carries the carrier webhook URLs, which moved off Settings", async () => {
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });
    const origin = window.location.origin;
    await waitFor(() =>
      expect(screen.getByText(`${origin}/demo/phone?carrier=twilio`)).toBeTruthy(),
    );
    expect(screen.getByText(`${origin}/demo/phone?carrier=telnyx`)).toBeTruthy();
  });
});
