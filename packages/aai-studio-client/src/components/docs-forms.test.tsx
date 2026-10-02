// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// `FormFieldsApi` — the API pane's form-field card: one control is one
// property of the run `input`, generated from the agent's own input schemas.
//
// Rendered through the API pane (moved from panes/docs.test.tsx), so every
// property it names is read off a stubbed agent.

import { screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { jsonResponse, renderWithClient, stubFetch } from "../_test-utils.ts";
import { DocsPane } from "../panes/docs.tsx";

const SECRETS = "/studio/projects/demo/secret";

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

describe("FormFieldsApi", () => {
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
});
