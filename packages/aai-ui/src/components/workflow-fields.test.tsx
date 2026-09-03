// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * A form generated from a workflow's declared input schema.
 *
 * The claim under test is the one that makes the component worth having: the
 * fields a page shows are a function of the schema `agent.ts` declares, so
 * adding a property there adds a control here. Its complement is asserted just
 * as hard — a property with no honest control produces NO control, rather than
 * a guess that submits a value the schema then rejects.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import { Form, SubmitButton } from "./form.tsx";
import { WorkflowFields } from "./workflow-fields.tsx";

function renderFields(inputSchema: unknown, uploads?: readonly string[]) {
  const workflow: WorkflowSummary = {
    name: "transcribe",
    inputSchema,
    ...omitUndefined({ uploads }),
  };
  render(
    <ThemeProvider>
      <form>
        <WorkflowFields workflow={workflow} />
      </form>
    </ThemeProvider>,
  );
}

/** Every named control the generated form contains. */
function fieldNames(): string[] {
  return Array.from(document.querySelectorAll("[name]")).map((el) => el.getAttribute("name") ?? "");
}

describe("WorkflowFields", () => {
  test("renders one control per scalar property, named for the schema key", () => {
    renderFields({
      type: "object",
      properties: {
        requestedBy: { type: "string" },
        segments: { type: "integer" },
        redact: { type: "boolean" },
      },
      required: ["requestedBy"],
    });
    expect(fieldNames().sort((a, b) => a.localeCompare(b))).toEqual([
      "redact",
      "requestedBy",
      "segments",
    ]);
  });

  test("renders a DECLARED UPLOAD as a file picker, not the text box its type says", () => {
    // An upload property is a string in the schema — it carries the id — so
    // without the workflow's own `uploads` list the page would ask a person to
    // type an id no person has.
    renderFields(
      {
        type: "object",
        properties: {
          recording: { type: "string", description: "A linear-PCM WAV recording" },
          languageCode: { type: "string" },
        },
        required: ["recording"],
      },
      ["recording"],
    );
    const recording = document.querySelector('[name="recording"]') as HTMLInputElement;
    expect(recording.type).toBe("file");
    expect(recording.required).toBe(true);
    // The upload read mode is what makes `<Form>` contribute the File itself.
    expect(recording.dataset.aaiRead).toBe("upload");
    // Its neighbour is untouched.
    expect((document.querySelector('[name="languageCode"]') as HTMLInputElement).type).toBe("text");
  });

  test("labels a field from its key and hints it from `.describe()`", () => {
    renderFields({
      type: "object",
      properties: { requestedBy: { type: "string", description: "Who it is filed under" } },
    });
    // `recordingId` → `Recording id`: a default, which is why a schema whose
    // labels matter should carry a description.
    expect(screen.getByLabelText("Requested by")).toBeTruthy();
    expect(screen.getByText("Who it is filed under")).toBeTruthy();
  });

  test("marks a required property required, so the browser blocks the submit", () => {
    renderFields({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    });
    expect(document.querySelector("[name=a]")?.hasAttribute("required")).toBe(true);
    expect(document.querySelector("[name=b]")?.hasAttribute("required")).toBe(false);
  });

  test("renders an enum as a dropdown rather than a free-text field", () => {
    renderFields({ type: "object", properties: { lang: { type: "string", enum: ["en", "fr"] } } });
    const select = document.querySelector("select[name=lang]");
    expect(select).toBeTruthy();
    expect(select?.querySelectorAll("option")).toHaveLength(2);
  });

  test("takes the non-null half of a nullable union's type", () => {
    // `["string", "null"]` is how an optional-and-nullable field converts, and
    // the control the non-null half wants is the right one.
    renderFields({ type: "object", properties: { note: { type: ["string", "null"] } } });
    expect(document.querySelector("input[name=note]")?.getAttribute("type")).toBe("text");
  });

  test("skips a property with no honest default control", () => {
    // An object or an array has no obvious control, and a guess that submits a
    // value the schema rejects is worse than no field — the page writes that
    // one itself.
    renderFields({
      type: "object",
      properties: {
        upload: { type: "object" },
        tags: { type: "array" },
        requestedBy: { type: "string" },
      },
    });
    expect(fieldNames()).toEqual(["requestedBy"]);
  });

  test("renders nothing for a workflow that declared no schema", () => {
    render(
      <ThemeProvider>
        <form>
          <WorkflowFields workflow={{ name: "transcribe" }} />
        </form>
      </ThemeProvider>,
    );
    // A workflow with no declared input takes anything, and a form for
    // "anything" is not a form.
    expect(fieldNames()).toEqual([]);
  });

  test("renders nothing before the listing has arrived", () => {
    render(
      <ThemeProvider>
        <form>
          <WorkflowFields />
        </form>
      </ThemeProvider>,
    );
    expect(fieldNames()).toEqual([]);
  });
});

/**
 * Handed a NAME, the component fetches the listing itself.
 *
 * This is the form a page normally uses, and its whole justification is the
 * three lines it replaces — a `useWorkflows()`, a `.find()` by name, and folding
 * that lookup's error into the form's.
 */
describe("WorkflowFields resolving by name", () => {
  /** A `fetch` answering `GET /workflows`, counting how often it was called. */
  function stubListing(workflows: WorkflowSummary[]) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ workflows }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return calls;
  }

  test("reads the listing and renders the named workflow's schema", async () => {
    stubListing([
      { name: "other", inputSchema: { type: "object", properties: { nope: { type: "string" } } } },
      {
        name: "transcribe",
        inputSchema: { type: "object", properties: { requestedBy: { type: "string" } } },
      },
    ]);
    render(
      <ThemeProvider>
        <form>
          <WorkflowFields workflow="transcribe" />
        </form>
      </ThemeProvider>,
    );
    // The fields it renders are the NAMED workflow's, not the first entry's.
    await vi.waitFor(() => expect(fieldNames()).toEqual(["requestedBy"]));
  });

  test("requests nothing when it is handed a summary it already has", () => {
    // The reason the hook takes a `skip`: a page holding its own listing must
    // not make this component fetch a second copy of it.
    const calls = stubListing([]);
    render(
      <ThemeProvider>
        <form>
          <WorkflowFields workflow={{ name: "transcribe" }} />
        </form>
      </ThemeProvider>,
    );
    expect(calls).toEqual([]);
  });

  test("cannot be submitted before the fields it validates exist", async () => {
    // The reported bug. `<Form>` leans on NATIVE validation, so a `required`
    // field is what stops an empty submit — and while the listing is in flight
    // there are no fields, so the browser had nothing to check. The first click
    // on the transcription desk therefore sent `{}` and the agent answered
    // `Invalid input for workflow "transcribeStream": recording: Invalid input`:
    // a schema complaint about a file picker that appeared a moment later.
    const listing = Promise.withResolvers<WorkflowSummary[]>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ workflows: await listing.promise }))),
    );
    const onSubmit = vi.fn();
    render(
      <ThemeProvider>
        <Form onSubmit={onSubmit}>
          <WorkflowFields workflow="transcribeStream" />
          <SubmitButton>Transcribe</SubmitButton>
        </Form>
      </ThemeProvider>,
    );
    const button = screen.getByRole("button", { name: "Transcribe" });
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
    // And it is visibly unavailable rather than silently inert — the fieldset
    // that already covers the in-flight case covers this one too. Matched with
    // `:disabled` rather than read off `.disabled`, which reflects the button's
    // OWN attribute and is false for one disabled by an ancestor fieldset.
    expect(button.matches(":disabled")).toBe(true);

    // Inside `act`, because resolving this settles the component's own fetch and
    // the state update that follows is React's, not the test's.
    await act(async () => {
      listing.resolve([
        {
          name: "transcribeStream",
          inputSchema: {
            type: "object",
            properties: { recording: { type: "string" } },
            required: ["recording"],
          },
          uploads: ["recording"],
        },
      ]);
    });
    // Once the declaration lands the form works again, and the empty submit is
    // now refused by the BROWSER — which is what should have happened all along.
    await vi.waitFor(() => expect(fieldNames()).toEqual(["recording"]));
    expect(button.matches(":disabled")).toBe(false);
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector("[name=recording]")?.hasAttribute("required")).toBe(true);
  });

  test("renders nothing for a name the agent does not declare", async () => {
    // A typo'd name is a form with no fields rather than a crash — and the
    // submit it sits beside answers with the agent's own 400 naming the
    // workflows that do exist.
    stubListing([{ name: "transcribe", inputSchema: { type: "object", properties: {} } }]);
    render(
      <ThemeProvider>
        <form>
          <WorkflowFields workflow="transcirbe" />
        </form>
      </ThemeProvider>,
    );
    await vi.waitFor(() => expect(fieldNames()).toEqual([]));
  });
});
