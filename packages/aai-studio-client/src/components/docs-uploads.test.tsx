// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// `UploadApi` — the API pane's "Sending a file" card: how a caller actually
// gets a file into this agent, generated from the agent's own listing, and
// shown only to an agent some workflow of which declares an upload.
//
// Rendered through the API pane (moved from panes/docs.test.tsx), so the
// workflow and property the examples name are read off a stubbed agent.

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

/** The same, for an agent whose workflow takes a FILE — what the upload card needs. */
function uploadListing() {
  return {
    "GET /demo/workflows": () =>
      jsonResponse({
        workflows: [
          {
            name: "transcribe",
            inputSchema: { type: "object", properties: { audio_file: { type: "string" } } },
            uploads: ["audio_file"],
          },
        ],
      }),
    [`GET ${SECRETS}`]: () => jsonResponse({ vars: [], pending: [] }),
    "GET /demo/client-config": () => jsonResponse({ name: "Desk", page: "static" }),
  };
}

function renderPane(props: { deployedSlug?: string; previewSlug?: string } = {}) {
  renderWithClient(<DocsPane bearer="sk-test" project="demo" {...props} />);
}

describe("UploadApi", () => {
  test("documents how to actually SEND the file a workflow declares", async () => {
    // The routes have been in the table since the pane existed and the run body
    // has always carried an upload id; what was missing was the call that
    // produces one. The card is generated from the agent's own listing — the
    // workflow name and the property in the start-first example are this
    // deployment's — and it leads with the client SDK, with the shell behind the
    // same disclosure every other section uses.
    stubFetch(uploadListing());
    renderPane({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText(/Sending a file/)).toBeTruthy());
    expect(screen.getByText(/audio_file property carries an upload id/)).toBeTruthy();
    expect(screen.getByText(/const stored = await agent\.upload\(file, \{/)).toBeTruthy();
    // The start-first shape, on an id the caller minted — the reason the PUT
    // route exists beside the POST.
    expect(screen.getByText(/await agent\.uploadStream\(audioFileUploadId, file/)).toBeTruthy();
    expect(screen.getByText(/await agent\.uploadInfo\("<upload id>"\)/)).toBeTruthy();
  });

  test("and the shell alternate really uploads, rather than naming a placeholder id", async () => {
    // The failure this closes: a `curl` reader was handed a run body containing
    // `<upload id for audio_file>` and no documented way to obtain one.
    stubFetch(uploadListing());
    renderPane({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText(/Sending a file/)).toBeTruthy());
    expect(screen.getAllByText(/--data-binary @recording\.wav/).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/AUDIO_FILE_UPLOAD_ID=\$\(curl -s -X POST/).length).toBeTruthy();
    expect(screen.queryByText(/<upload id for/)).toBeNull();
  });

  test("an agent whose workflows take no file is not shown the upload card", async () => {
    // The routes exist for it — the platform proxies them for every agent — and
    // there is no input property for an id to go in, which is the same
    // judgement that keeps the workflow table off a voice agent. The positive
    // above is what makes this an absence rather than a card that failed.
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByText("digest")).toBeTruthy());
    expect(screen.queryByText(/Sending a file/)).toBeNull();
  });
});
