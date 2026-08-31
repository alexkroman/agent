// Copyright 2026 the AAI authors. MIT license.
// The two snippets that answer "how do I set each of these fields", one per
// language, ANNOTATED with the control each property is.
//
// **Why these are not the run snippets next door.** `sdkStart`/`curlStart`
// (docs-snippets.ts) send exactly the same body and are the right shape for
// their card — the shortest runnable thing, one line. What they cannot do is
// carry the correspondence, because a compact literal has nowhere to put it:
// `{"topic":"<topic>","draft":false}` is a correct body that says nothing about
// which box on the page each half came from, and the property a reader most
// needs told (a file) is the one that looks least like what it is. So the body
// is expanded one property per line, each with the control it is, and the
// sample values come from the SAME sampler the compact version uses so the two
// cannot disagree about what this deployment's `topic` looks like.
//
// **They are generated against ONE real workflow.** A synthesized example
// carrying one property of every kind would be the more complete table and an
// unpastable body — the properties would come from two different workflows and
// the run would 400 on the first one the schema does not know. See
// `fieldsWorkflow`: the workflow declaring the most fields wins, and the row
// examples in the table beside it fill in the kinds that workflow lacks.

import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import { WORKFLOWS_PATH } from "./docs-content.ts";
import { type ClassifiedField, classifiedFields } from "./docs-form-fields.ts";
import { curlStart, sdkClient, uploadLines, uploadVar } from "./docs-snippets.ts";

/** A property as an object-literal key — quoted only when it has to be. */
function jsKey(property: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property) ? property : JSON.stringify(property);
}

/**
 * What a property's value is in an SDK snippet.
 *
 * An upload is the one that differs from the JSON: the run carries the id, and
 * printing the string a caller cannot produce would document the wrong half of
 * the call — so it renders as the EXPRESSION reading the id off the upload the
 * lines above it made.
 */
function sdkValue(field: ClassifiedField): string {
  return field.kind === "file" ? `${uploadVar(field.property)}.id` : field.value;
}

/**
 * The `key: value, // <Control>` lines of an annotated input literal, with the
 * comments aligned.
 *
 * Aligned because the comment column is the whole point of this snippet — it is
 * a two-column table that happens to compile, and a ragged right edge makes it
 * read as trailing remarks instead.
 */
function annotatedLines(fields: readonly ClassifiedField[]): string[] {
  const entries = fields.map((field) => ({
    code: `  ${jsKey(field.property)}: ${sdkValue(field)},`,
    element: field.element,
  }));
  const width = Math.max(...entries.map((entry) => entry.code.length));
  return entries.map((entry) => `${entry.code.padEnd(width)} // ${entry.element}`);
}

/** The pair of snippets for one workflow's fields. */
export type FieldSnippets = {
  /** The annotated SDK call — what the card leads with. */
  sdk: string;
  /** The same call from a shell, mapping and all. */
  shell: string;
};

/**
 * Setting every field of one workflow, in both languages.
 *
 * ONE entry point rather than two exported builders, because the two are
 * present together or not at all — both are empty for a workflow that declares
 * no property — and two `string | undefined`s would leave the caller narrowing
 * a pair that cannot disagree, which is a branch no test can reach. It also
 * classifies the schema once instead of twice.
 *
 * `undefined` for a workflow declaring no properties: there is nothing to
 * annotate, and an empty literal reads as a body somebody forgot to fill in.
 */
export function fieldSnippets(
  base: string,
  workflow: WorkflowSummary,
  token: boolean,
): FieldSnippets | undefined {
  const fields = classifiedFields(workflow);
  if (fields.length === 0) return undefined;
  return {
    sdk: sdkFields(base, workflow, token, fields),
    shell: curlFields(base, workflow, token, fields),
  };
}

/** The annotated SDK call: the client, the uploads, then one line per control. */
function sdkFields(
  base: string,
  workflow: WorkflowSummary,
  token: boolean,
  fields: readonly ClassifiedField[],
): string {
  return [
    sdkClient(base, token),
    "",
    ...uploadLines(workflow),
    "// One input property per control on the page's form.",
    `const run = await agent.startAndWait(${JSON.stringify(workflow.name)}, {`,
    ...annotatedLines(fields),
    "});",
    `console.log(run.status, run.status === "completed" ? run.output : run);`,
  ].join("\n");
}

/**
 * The same, from a shell.
 *
 * The mapping goes ABOVE the command rather than inside it: the body sits in
 * single quotes on one line, deliberately (see `curlStartCommand`), so a
 * per-property comment has nowhere to live in it. The command itself is
 * `curlStart` unchanged — including the upload it runs first — because a second
 * copy of the shell start is how one of the two comes to name a route the
 * platform no longer proxies.
 */
function curlFields(
  base: string,
  workflow: WorkflowSummary,
  token: boolean,
  fields: readonly ClassifiedField[],
): string {
  const width = Math.max(...fields.map((field) => field.property.length));
  return [
    `# POST ${base}/${WORKFLOWS_PATH}/runs — one input property per control:`,
    ...fields.map((field) => `#   ${field.property.padEnd(width)}  ${field.element}`),
    "",
    curlStart(base, workflow, token),
  ].join("\n");
}
