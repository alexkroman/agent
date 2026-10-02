// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// `AgentApiDocs` — one agent's HTTP API, rendered from what that agent itself
// answers.
//
// What matters here is that the workflow half is GENERATED rather than written
// — the request bodies carry the field names the deployed agent declares, so a
// snippet is current by construction — that it reads the AGENT's API rather
// than a studio route, and that each half is offered only to the agents it is
// TRUE for: no carrier webhook for a workflow app, no workflow routes for an
// agent that declares no workflow. Both are read off the agent, so both are
// asserted through a stubbed answer from it.
//
// Rendered through the studio's API pane (moved from panes/docs.test.tsx),
// which is the caller that fills the voice-only slot; the public page's
// differences are public-api.test.tsx's.

import { screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { jsonResponse, renderWithClient, stubFetch } from "../_test-utils.ts";
import { DocsPane } from "../panes/docs.tsx";

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

describe("AgentApiDocs", () => {
  test("generates the request body from the agent's own input schema", async () => {
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });

    // Three snippets carry it — the run card's SDK call and its `curl`
    // alternate, plus the form card's shell alternate, which re-emits the
    // whole pastable command rather than a fragment. An exact count rather
    // than a floor: a body appearing somewhere unexpected is the failure this
    // assertion is for.
    await waitFor(() => expect(screen.getAllByText(/"topic":"<topic>"/).length).toBe(3));
    // The base URL is this page's origin plus the slug, which is what makes
    // the snippet runnable rather than illustrative.
    const origin = window.location.origin;
    // Both the run card's shell alternate and the form card's carry the whole
    // command, so this is a floor rather than an exact match.
    expect(
      screen.getAllByText(new RegExp(`curl -X POST ${origin}/demo/workflows/runs`)).length,
    ).toBeGreaterThan(1);
  });

  test("every example is an SDK call, with curl one disclosure away", async () => {
    // The pane used to lead with `curl` everywhere, which taught the routes and
    // left the reader to re-derive what the client already knows — that
    // `startAndWait` is one held-open request rather than a poll loop, that an
    // `idle` frame means re-open, that an upload's bytes go in once. So the SDK
    // is the default and the shell is a disclosure, not a tab nobody finds.
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });

    // The compact form specifically: the form card's annotated version of the
    // same call opens `startAndWait("digest", {` and breaks the line there.
    await waitFor(() =>
      expect(screen.getByText(/agent\.startAndWait\("digest", \{"topic"/)).toBeTruthy(),
    );
    // The client the snippets are written against is offered before the routes.
    expect(screen.getByText("npm i @alexkroman1/aai")).toBeTruthy();
    expect(screen.getAllByText(/createAgentClient\(/).length).toBeGreaterThan(1);
    // The reads a caller reaches for next, in the same client.
    expect(screen.getByText(/agent\.get\("<run id>"/)).toBeTruthy();
    expect(screen.getByText(/for await \(const run of agent\.follow\("<run id>"\)\)/)).toBeTruthy();
    // `agent.list()` is a ROUTE TABLE line, and this pane no longer carries
    // one — see the route-table test below, and public-api.test.tsx for the
    // page that keeps it.
    expect(screen.queryByText("agent.list()")).toBeNull();
    // Every alternate really is behind a disclosure — a `<summary>` a reader
    // opens, so nothing on the page presents the shell version as the way in.
    const disclosures = screen.getAllByText(/^Same call with /);
    expect(disclosures.length).toBeGreaterThan(2);
    for (const disclosure of disclosures) expect(disclosure.tagName).toBe("SUMMARY");
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
    // `mode: "workflow-app"` declines `/websocket` and cannot declare a carrier, so
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
    // The workflow half, which on THIS pane is the run examples rather than a
    // route table — see below.
    expect(screen.getByText("digest")).toBeTruthy();
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
});
