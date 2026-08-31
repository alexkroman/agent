// Copyright 2026 the AAI authors. MIT license.
// The annotated form-field snippets — the pair whose whole job is a column of
// comments beside a request body.
//
// Tested directly for the reason every snippet builder here is: a body with a
// field spelled differently than the workflow declared it renders perfectly and
// 400s when somebody pastes it. What is specific to this pair is that the
// ANNOTATION can be wrong on its own — a comment naming `<TextField>` beside a
// boolean is a correct request teaching the reader the wrong control, and it
// looks right in a screenshot.

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import { describe, expect, test } from "vitest";
import { fieldSnippets } from "./docs-field-snippets.ts";

const BASE = "https://api.example.com/demo";

function workflow(name: string, inputSchema?: unknown, uploads?: readonly string[]) {
  return { name, ...omitUndefined({ inputSchema, uploads }) };
}

const PUBLISH = workflow(
  "publish",
  {
    type: "object",
    properties: {
      topic: { type: "string" },
      count: { type: "integer" },
      draft: { type: "boolean" },
      cover: { type: "string" },
    },
  },
  ["cover"],
);

/**
 * The pair, or a failure naming the workflow.
 *
 * Every case below declares fields, so `undefined` is a bug rather than a
 * branch to handle — and failing here says which workflow stopped producing
 * them, where a `?? ""` would report an empty string missing a substring.
 *
 * A bare `throw` rather than `expect.fail`, which Biome's
 * `noMisplacedAssertion` forbids outside a test body.
 */
function pair(wf: WorkflowSummary, token = false) {
  const snippets = fieldSnippets(BASE, wf, token);
  if (snippets === undefined) throw new Error(`${wf.name} produced no field snippets`);
  return snippets;
}

describe("fieldSnippets — the SDK half", () => {
  test("labels each property with the control it is", () => {
    const { sdk } = pair(PUBLISH);
    expect(sdk).toContain('agent.startAndWait("publish", {');
    expect(sdk).toContain("// <TextField>");
    expect(sdk).toContain("// <NumberField>");
    expect(sdk).toContain("// <CheckboxField>");
    expect(sdk).toContain("// <FileField upload>");
  });

  test("and puts the label on the RIGHT property", () => {
    // The failure this catches: a correct request body whose comments have
    // slipped by one, which teaches the wrong control and reads fine.
    const lines = pair(PUBLISH).sdk.split("\n");
    const labelled = (property: string) =>
      lines.find((line) => line.trimStart().startsWith(`${property}:`));
    expect(labelled("topic")).toContain("// <TextField>");
    expect(labelled("count")).toContain("// <NumberField>");
    expect(labelled("draft")).toContain("// <CheckboxField>");
    expect(labelled("cover")).toContain("// <FileField upload>");
  });

  test("aligns the comment column", () => {
    // The column IS the snippet's argument — it is a two-column table that
    // happens to compile — and a ragged edge reads as trailing remarks.
    const columns = pair(PUBLISH)
      .sdk.split("\n")
      .filter((line) => line.includes(" // <"))
      .map((line) => line.indexOf("//"));
    expect(columns.length).toBe(4);
    expect(new Set(columns).size).toBe(1);
  });

  test("renders an upload as the EXPRESSION, not as a string", () => {
    // The bytes go in once and the run carries the handle, so the property
    // reads the id off the upload the lines above made. A quoted placeholder
    // would be a value the caller has no way to produce.
    const { sdk } = pair(PUBLISH);
    expect(sdk).toContain("cover: coverUpload.id,");
    expect(sdk).toContain('const coverUpload = await agent.upload(file, { name: "cover" });');
    expect(sdk).not.toContain('cover: "<upload id');
  });

  test("is self-contained, and carries the bearer when the API is closed", () => {
    // Every SDK snippet on the pane opens with its import and its client: the
    // unit of use is a paste, and one starting at the interesting line reads as
    // a fragment of a file the reader does not have.
    const open = pair(PUBLISH).sdk;
    expect(open).toContain('import { createAgentClient } from "@alexkroman1/aai/workflow-api";');
    expect(open).not.toContain("AAI_WORKFLOW_API_TOKEN");
    expect(pair(PUBLISH, true).sdk).toContain("token: process.env.AAI_WORKFLOW_API_TOKEN");
  });

  test("quotes a property name that is not an identifier", () => {
    // A JSON Schema property may be anything; an object-literal key may not.
    const odd = workflow("odd", { type: "object", properties: { "a-b": { type: "string" } } });
    expect(pair(odd).sdk).toContain('"a-b":');
  });
});

describe("fieldSnippets — the shell half", () => {
  test("carries the mapping as comments above a runnable command", () => {
    // The body is one single-quoted shell line by design, so a per-property
    // comment has nowhere to live inside it.
    const { shell } = pair(PUBLISH);
    expect(shell).toContain(`# POST ${BASE}/workflows/runs — one input property per control:`);
    expect(shell).toContain("#   topic  <TextField>");
    expect(shell).toContain("#   cover  <FileField upload>");
  });

  test("reuses the pane's own shell start, upload and all", () => {
    // Not a second copy of the command: two spellings of a route is how one of
    // them comes to name a prefix the platform no longer proxies. So the upload
    // that mints the id, and the expansion that puts it in the body, both come
    // along.
    const { shell } = pair(PUBLISH);
    expect(shell).toContain(`COVER_UPLOAD_ID=$(curl -s -X POST "${BASE}/workflows/uploads?name=`);
    expect(shell).toContain(`curl -X POST ${BASE}/workflows/runs`);
    expect(shell).toContain(`"cover":"'"$COVER_UPLOAD_ID"'"`);
  });

  test("carries the bearer on both calls when the API is closed", () => {
    // Closing the workflow API closes the upload routes with it, so a snippet
    // that authorized only the start would 401 on its first line.
    const { shell } = pair(PUBLISH, true);
    expect(shell.match(/Authorization: Bearer \$AAI_WORKFLOW_API_TOKEN/g)?.length).toBe(2);
  });
});

describe("fieldSnippets", () => {
  test("is ABSENT for a workflow that declares no property", () => {
    // Nothing to annotate. An empty literal reads as a body somebody forgot —
    // and both halves go together, which is why this is one entry point.
    expect(fieldSnippets(BASE, workflow("digest"), false)).toBeUndefined();
    expect(fieldSnippets(BASE, workflow("digest", { type: "object" }), false)).toBeUndefined();
  });
});
