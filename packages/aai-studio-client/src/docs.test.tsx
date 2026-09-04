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
// It also hands out the PUBLIC link (`/studio/api/<slug>`) — the one thing
// this pane cannot do for itself, being behind sign-in and scoped to the
// account that owns the project. The page behind that link is public-api.tsx,
// whose own suite pins the boundary; here it is the link, and which agent it
// names before a first publish.
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

/**
 * An agent whose one workflow declares a property of every shape a form has a
 * control for — what the form-field card is generated from.
 */
function formListing() {
  return {
    "GET /demo/workflows": () =>
      jsonResponse({
        workflows: [
          {
            name: "publish",
            inputSchema: {
              type: "object",
              properties: {
                topic: { type: "string" },
                count: { type: "integer" },
                tone: { enum: ["formal", "casual"] },
                draft: { type: "boolean" },
                tags: { type: "array", items: { type: "string" } },
                cover: { type: "string" },
              },
            },
            uploads: ["cover"],
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
    // `page: "static"` declines `/websocket` and cannot declare a carrier, so
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

  test("carries no /workflows route table — the studio has a pane for that", async () => {
    // The routes are all still CALLED on this pane, in the snippets; what is
    // gone is the twelve-row reference table, which is what somebody writing a
    // client wants and not what a studio user is asking of their own agent.
    // They also have a Workflows tab beside this one. The public page keeps the
    // table (public-api.test.tsx) — the asymmetry is the feature.
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText("digest")).toBeTruthy());
    const origin = window.location.origin;
    expect(screen.queryByText(`${origin}/demo/workflows`)).toBeNull();
    expect(screen.queryByText(`${origin}/demo/workflows/runs`)).toBeNull();
    expect(screen.queryByText(`${origin}/demo/workflows/uploads?name=`)).toBeNull();
    // The front door's OWN table stays: it is three rows about this agent's
    // shape, not a reference for a subsystem with a tab of its own.
    expect(screen.getByText(`${origin}/demo/client-config`)).toBeTruthy();
  });

  test("and the openness sentence follows the reader rather than the table", async () => {
    // Whether the workflow API is closed is the one thing on this half only
    // the STUDIO can say — it reads the project's secrets — so hiding the
    // table it normally sits on must not drop it.
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByText(/open by default/)).toBeTruthy());
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

  test("hands out the PUBLIC link for this agent's API", async () => {
    // The one thing this pane cannot do for itself: it is behind sign-in and
    // scoped to the owning account, so "send me your API docs" has no answer
    // without a link that needs no session. Both forms are on screen because
    // the two uses differ — pasting it to somebody else, and opening it to
    // check what they will see.
    stubFetch(listing());
    renderPane({ deployedSlug: "demo" });

    const url = `${window.location.origin}/studio/api/demo`;
    await waitFor(() => expect(screen.getByText(url)).toBeTruthy());
    const link = screen.getByRole("link", { name: /Open the public page/ });
    expect(link.getAttribute("href")).toBe(url);
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

    await waitFor(() =>
      expect(screen.getByText(`${window.location.origin}/studio/api/demo-preview`)).toBeTruthy(),
    );
    expect(screen.getByText(/points at the PREVIEW agent/)).toBeTruthy();
  });

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

  test("maps every form control to the JSON that sets it", async () => {
    // The correspondence a caller needs and the pane used to leave to
    // inference: one control is one property of the run `input`. Every control
    // is listed whether or not this agent declares one — the vocabulary IS the
    // answer to "what can I send" — so a table that dropped a row because
    // today's schema has no boolean would teach that the API cannot take one.
    stubFetch(formListing());
    renderPane({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText(/Every form field, over HTTP/)).toBeTruthy());
    for (const control of [
      "<TextField>",
      "<TextAreaField>",
      "<NumberField>",
      "<SelectField>",
      "<CheckboxField>",
      "<FileField upload>",
    ]) {
      expect(screen.getByText(control)).toBeTruthy();
    }
    // A nested shape gets no generated control and the API takes it anyway,
    // which is a different sentence from "the API will not accept this". Its
    // row, and the annotated snippets, which label the property the same way.
    expect(screen.getAllByText(/no generated control/).length).toBe(3);
  });

  test("and names THIS agent's own property on each row it has one for", async () => {
    // Generated, like every other body on the pane: a hand-written table would
    // teach `"topic"` to a project whose field is `subject`. Each row says
    // which it is showing, because a placeholder read as a real field name is
    // how somebody pastes a 400.
    stubFetch(formListing());
    renderPane({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText(/Every form field, over HTTP/)).toBeTruthy());
    // A `SelectField` sends one member of the declared enum — a REAL value,
    // and the only row whose sample is not a placeholder.
    expect(screen.getByText('tone: "formal"')).toBeTruthy();
    expect(screen.getByText("draft: false")).toBeTruthy();
    expect(screen.getByText("count: 0")).toBeTruthy();
    // An upload property is a plain string in the schema, so this is the row
    // inference gets wrong: the value is a handle, not the file.
    expect(screen.getByText('cover: "<upload id>"')).toBeTruthy();
    expect(screen.getAllByText(/Declared by publish\./).length).toBeGreaterThan(4);
    // The one control no schema selects: a textarea and a text field are the
    // same string over the wire, so matching a property to it would put one
    // property on two rows claiming to be two controls.
    expect(screen.getByText(/Example — this agent declares none/)).toBeTruthy();
  });

  test("and the annotated call labels each property with its control", async () => {
    // The compact run body is correct and says nothing about which box each
    // half came from. This is the same call expanded one property per line —
    // and against a REAL workflow, because a synthesized every-kind body would
    // mix two workflows' properties and 400 on the first one.
    stubFetch(formListing());
    renderPane({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText(/Every form field, over HTTP/)).toBeTruthy());
    // Found by an annotated LINE rather than by the opening brace: testing
    // library normalizes whitespace before matching, so a newline-anchored
    // pattern cannot see the line break this snippet's whole shape depends on.
    const annotated = screen.getByText(/topic: "<topic>", +\/\/ <TextField>/);
    expect(annotated.textContent).toContain('agent.startAndWait("publish", {');
    expect(annotated.textContent).toContain("// <NumberField>");
    // The upload renders as the EXPRESSION reading the id off the upload the
    // lines above made — not as a string a caller cannot produce.
    expect(annotated.textContent).toContain("cover: coverUpload.id,");
    expect(annotated.textContent).toContain("await agent.upload(file,");
    // The shell alternate carries the mapping as comments, the body being one
    // single-quoted line with nowhere to put them. Read off `textContent`
    // rather than matched: the columns are aligned, and testing library's
    // matcher normalizes runs of whitespace away before it compares.
    const shell = screen.getByText(/— one input property per control:/);
    expect(shell.textContent).toContain("#   tone   <SelectField>");
    expect(shell.textContent).toContain("#   cover  <FileField upload>");
  });

  test("and the table stands alone when no workflow declares a schema", async () => {
    // A real shape: input is optional, so there is nothing to annotate and no
    // pastable body to offer. The vocabulary is still the answer to "what can I
    // send", so the table stays — with every row a placeholder, said as such.
    stubFetch({
      "GET /demo/workflows": () => jsonResponse({ workflows: [{ name: "digest" }] }),
      "GET /demo/client-config": () => jsonResponse({ page: "static" }),
      [`GET ${SECRETS}`]: () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPane({ deployedSlug: "demo" });

    await waitFor(() => expect(screen.getByText(/Every form field, over HTTP/)).toBeTruthy());
    expect(screen.getByText("<CheckboxField>")).toBeTruthy();
    expect(screen.getAllByText(/Example — this agent declares none/).length).toBe(7);
    expect(screen.queryByText(/each property labelled by the control it is/)).toBeNull();
  });

  test("but not for an agent that declares no workflow at all", async () => {
    // Same judgement as the rest of the pane: with nothing declared there is
    // no run body for a control to be a property of.
    stubFetch({
      "GET /demo/workflows": () => jsonResponse({ workflows: [] }),
      "GET /demo/client-config": () => jsonResponse({ page: "voice" }),
      [`GET ${SECRETS}`]: () => jsonResponse({ vars: [], pending: [] }),
    });
    renderPane({ deployedSlug: "demo" });
    await waitFor(() => expect(screen.getByText(/declares no workflows/)).toBeTruthy());
    expect(screen.queryByText(/Every form field, over HTTP/)).toBeNull();
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
