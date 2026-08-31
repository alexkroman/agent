// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The PUBLIC API page (`/studio/api/<slug>`): one deployed agent's HTTP
// surface, at a link that needs no studio account.
//
// What matters here is what it does NOT do. The page shares its whole body
// with the studio's API pane, so the assertions that the docs are generated
// from the agent's own listing live in docs.test.tsx; these pin the boundary
// that makes the page publishable — it reads the AGENT and nothing else, so a
// signed-out reader triggers no account-scoped request, and the two
// account-scoped things the studio pane adds (the project's secrets, and the
// carrier webhook card those secrets feed) are absent.

import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, renderWithClient, stubFetch } from "./_test-utils.ts";
import { PublicApiPage } from "./public-api.tsx";

/** A voice agent that declares one workflow — the fullest shape there is. */
function agent() {
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
    "GET /demo/client-config": () => jsonResponse({ name: "Demo", page: "voice" }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PublicApiPage", () => {
  test("documents the agent the path names, from the agent's own listing", async () => {
    stubFetch(agent());
    renderWithClient(<PublicApiPage slug="demo" />);

    await waitFor(() => expect(screen.getByText("digest")).toBeTruthy());
    // Generated, so the field name is this deployment's — the same guarantee
    // the studio pane makes, which is the point of sharing the body. Three
    // copies: the run card's SDK call and its `curl` alternate, plus the form
    // card's shell alternate, which re-emits the whole pastable command.
    expect(screen.getAllByText(/"topic":"<topic>"/).length).toBe(3);
    // The slug is the heading: it is known without a fetch, where the agent's
    // own name arrives with `client-config` and would leave the page titleless
    // for as long as a sandbox takes to boot.
    expect(screen.getByRole("heading", { name: "demo" })).toBeTruthy();
  });

  test("asks nothing of the studio — every request is the agent's own", async () => {
    const fetchMock = stubFetch(agent());
    renderWithClient(<PublicApiPage slug="demo" />);

    await waitFor(() => expect(screen.getByText("digest")).toBeTruthy());
    // The whole feature, as one assertion: a reader with no account must
    // trigger no account-scoped read. `/studio/projects/demo/secret` is the
    // one the studio pane makes, and a 401 from it would be invisible on
    // screen — the token line would simply be missing.
    const paths = fetchMock.mock.calls.map(
      ([input]) => new URL(String(input), window.location.origin).pathname,
    );
    expect(paths).toEqual(expect.arrayContaining(["/demo/workflows", "/demo/client-config"]));
    expect(paths.filter((path) => path.startsWith("/studio/"))).toEqual([]);
  });

  test("and carries none of the carrier webhook card, voice agent or not", async () => {
    // The route table's `POST /demo/phone` row stays — it is a public route
    // this agent answers, which is this page's subject. The CARD is the part
    // that reads the project's secrets to report whether request signing is
    // live, and that is nobody's business but the owner's.
    stubFetch(agent());
    renderWithClient(<PublicApiPage slug="demo" />);

    await waitFor(() => expect(screen.getByText("digest")).toBeTruthy());
    expect(screen.getByText(`${window.location.origin}/demo/phone`)).toBeTruthy();
    expect(screen.queryByText("Twilio")).toBeNull();
    expect(screen.queryByText("Telnyx")).toBeNull();
  });

  test("and DOES carry the /workflows route table, which the studio pane drops", async () => {
    // The one asymmetry that runs the other way, and it is a decision rather
    // than an oversight. A studio reader has a Workflows tab beside the API
    // pane and is asking what their own agent answers; this page's reader has a
    // slug and an integration to write, so the twelve-row reference is what
    // they came for. See `AgentApiDocsProps.workflowRoutes`.
    stubFetch(agent());
    renderWithClient(<PublicApiPage slug="demo" />);

    const origin = window.location.origin;
    await waitFor(() => expect(screen.getByText(`${origin}/demo/workflows`)).toBeTruthy());
    // Rows nothing else on the page spells. `/workflows/runs` is deliberately
    // NOT one to assert (two rows: the POST that starts a run and the GET that
    // lists recent ones), nor `/runs/:runId` (the GET and the DELETE).
    expect(screen.getByText(`${origin}/demo/workflows/runs/:runId/events`)).toBeTruthy();
    expect(screen.getByText(`${origin}/demo/workflows/uploads/:id/info`)).toBeTruthy();
    // Each row indexes into the client the page is written against, rather
    // than only naming a URL.
    expect(screen.getByText("agent.list()")).toBeTruthy();
  });

  test("names the agent's own sentence when the workflow listing is refused", async () => {
    // A closed workflow API (`AAI_WORKFLOW_API_TOKEN` set) refuses the listing
    // too, and this page cannot know that in advance — the bearer requirement
    // is a fact about the project's secrets. Quoting the agent is the honest
    // answer; inventing an `Authorization` line nobody can fill in is not.
    stubFetch({
      "GET /demo/workflows": () => jsonResponse({ error: "Unauthorized" }, 401),
      "GET /demo/client-config": () => jsonResponse({ page: "voice" }),
    });
    renderWithClient(<PublicApiPage slug="demo" />);

    await waitFor(() => expect(screen.getByText(/Unauthorized/)).toBeTruthy());
    // The rest of the page is still there: the routes a caller can reach do
    // not stop existing because one read was refused.
    expect(screen.getByText(`${window.location.origin}/demo/client-config`)).toBeTruthy();
  });
});
