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

import type { WorkflowSummary } from "@alexkroman1/aai";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ThemeProvider } from "../context.ts";
import { WorkflowFields } from "./workflow-fields.tsx";

function renderFields(inputSchema: unknown) {
  const workflow: WorkflowSummary = { name: "transcribe", inputSchema };
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
