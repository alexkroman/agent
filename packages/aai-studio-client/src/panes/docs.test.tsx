// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The API pane: the half of this project's HTTP documentation only the STUDIO
// can say.
//
// The body every caller shares is `AgentApiDocs` and its cards, whose specs are
// components/api-docs.test.tsx, docs-forms.test.tsx and docs-uploads.test.tsx.
// What is asserted here is the pane's own: the empty state before anything is
// deployed, the fallback to the PREVIEW agent (and saying so), the bearer line
// that only the project's secrets can justify, dropping the /workflows route
// table (the studio has a pane for it) while keeping the openness sentence,
// the carrier webhook URLs, and the PUBLIC link (`/studio/api/<slug>`) — the
// one thing this pane cannot do for itself, being behind sign-in. The page
// behind that link is public-api.tsx, whose own suite pins the boundary.

import { screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { jsonResponse, renderWithClient, stubFetch } from "../_test-utils.ts";
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

describe("DocsPane", () => {
  test("asks for a publish or an edit when nothing is deployed", () => {
    // With no slug there is no base URL, so every snippet would be a
    // placeholder somebody could paste and wonder about.
    renderPane();
    expect(screen.getByText(/Publish this project/)).toBeInTheDocument();
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
    expect(await screen.findByText(/preview agent/)).toBeInTheDocument();
  });

  test("names the bearer only when the agent's env closes the API", async () => {
    stubFetch(listing(["AAI_WORKFLOW_API_TOKEN"]));
    renderPane({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getAllByText(/Authorization: Bearer/).length).toBeTruthy());
  });

  test("carries no /workflows route table — the studio has a pane for that", async () => {
    // The routes are all still CALLED on this pane, in the snippets; what is
    // gone is the twelve-row reference table, which is what somebody writing a
    // client wants and not what a studio user is asking of their own agent.
    // They also have a Workflows tab beside this one. The public page keeps the
    // table (public-api.test.tsx) — the asymmetry is the feature.
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });

    expect(await screen.findByText("digest")).toBeInTheDocument();
    const origin = window.location.origin;
    expect(screen.queryByText(`${origin}/demo/workflows`)).toBeNull();
    expect(screen.queryByText(`${origin}/demo/workflows/runs`)).toBeNull();
    expect(screen.queryByText(`${origin}/demo/workflows/uploads?name=`)).toBeNull();
    // The front door's OWN table stays: it is three rows about this agent's
    // shape, not a reference for a subsystem with a tab of its own.
    expect(screen.getByText(`${origin}/demo/client-config`)).toBeInTheDocument();
  });

  test("and the openness sentence follows the reader rather than the table", async () => {
    // Whether the workflow API is closed is the one thing on this half only
    // the STUDIO can say — it reads the project's secrets — so hiding the
    // table it normally sits on must not drop it.
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });
    expect(await screen.findByText(/open by default/)).toBeInTheDocument();
  });

  test("hands out the PUBLIC link for this agent's API", async () => {
    // The one thing this pane cannot do for itself: it is behind sign-in and
    // scoped to the owning account, so "send me your API docs" has no answer
    // without a link that needs no session. Both forms are on screen because
    // the two uses differ — pasting it to somebody else, and opening it to
    // check what they will see.
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });

    const url = `${window.location.origin}/studio/api/demo`;
    expect(await screen.findByText(url)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Open the public page/ });
    expect(link).toHaveAttribute("href", url);
  });

  test("and says the link is the PREVIEW's before a first publish", async () => {
    // A preview slug is replaced on every edit and swept with the project, so
    // a link to one is not a link worth sending — and the pane documents that
    // agent whether or not anything is published, so the URL is real either
    // way. Naming which is the whole difference.
    stubFetch({
      "GET /demo-preview/workflows": () => jsonResponse({ workflows: [] }),
      "GET /demo-preview/client-config": () => jsonResponse({ page: "voice" }),
      [`GET ${SECRETS}`]: () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPane({ previewSlug: "demo-preview" });

    expect(
      await screen.findByText(`${window.location.origin}/studio/api/demo-preview`),
    ).toBeInTheDocument();
    expect(screen.getByText(/points at the PREVIEW agent/)).toBeInTheDocument();
  });

  test("carries the carrier webhook URLs, which moved off Settings", async () => {
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });
    const origin = window.location.origin;
    expect(await screen.findByText(`${origin}/demo/phone?carrier=twilio`)).toBeInTheDocument();
    expect(screen.getByText(`${origin}/demo/phone?carrier=telnyx`)).toBeInTheDocument();
  });
});
