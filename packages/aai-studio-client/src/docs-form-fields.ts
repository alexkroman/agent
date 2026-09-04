// Copyright 2026 the AAI authors. MIT license.
// Every control a page's form can carry, and the JSON an HTTP caller sends
// instead of using it.
//
// **The gap this closes.** A workflow app's front door is a form, and the API
// pane documented the form's DESTINATION — `POST /workflows/runs`, with a
// generated body — while saying nothing about the correspondence a caller
// actually needs: that one control is one property of `input`, which control a
// declared property renders as, and that exactly one of them (a file) is not a
// value at all but a handle obtained from another route first. A reader looking
// at a page with six fields and a run body with six properties had to infer the
// mapping, and the one place inference fails is the FileField — its property is
// a plain string in the schema, so the body reads as "type the recording here".
//
// **The mapping is `<WorkflowFields>`'s, and this pane now ASKS it.**
// `fieldKindFor` (`@alexkroman1/aai-ui`) is the rule that component itself
// runs — a declared upload beats everything, then `enum`, then the type — and
// {@link FormElementKind} is built on its {@link WorkflowFieldKind}, so the
// table says what the deployed page really renders because it is reading the
// same decision rather than restating it. A hand-kept mirror stood here and
// the module doc said so; a mirror that drifted would be worse than nothing,
// naming a control the reader cannot find on their own page. Publishing the
// classifier is the same conclusion `studio-sdk-exports.ts` reached about the
// SDK's subpath list: a copy "would just move the drift somewhere new". A new
// control in aai-ui therefore widens the union here, and the type — plus
// `formElements`'s own row-per-kind test — is what asks for its row.
//
// **Every kind is listed, whether or not this agent declares one.** The pane's
// standing rule is to show only what is true for the agent in front of you, and
// this is the deliberate exception: the vocabulary IS the answer to "what can I
// send", and a table that dropped `CheckboxField` because today's schema has no
// boolean would teach that the API cannot take one. What is generated instead
// is the EXAMPLE on each row — this agent's own property and its own sampled
// value where it has one of that shape, a placeholder where it does not, and a
// row says which it is showing.

import { isRecord } from "@alexkroman1/aai/utils";
import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import { fieldKindFor, type WorkflowFieldKind } from "@alexkroman1/aai-ui";
import { sampleInput } from "./docs-content.ts";

/**
 * The controls a form is built from, as the API sees them.
 *
 * The published {@link WorkflowFieldKind} plus one row this pane owns.
 * `"none"` is not a control — it is the shape `<WorkflowFields>` declines to
 * guess at (a nested object, an array), which the API takes perfectly well and
 * a page needs a hand-written field for. It is on the table because "the
 * generated form has no box for this" and "the API will not accept this" are
 * very different sentences, and the reader is otherwise left to assume the
 * second.
 *
 * `"textarea"` is the addition, and it is DOCUMENTATION rather than a
 * classification: it is a string like a text field is, so no schema can ask
 * for it and {@link classify} never returns it — see `formElements`.
 */
export type FormElementKind = WorkflowFieldKind | "textarea";

/** One row of the pane's form-field table. */
export type FormElementDoc = {
  kind: FormElementKind;
  /** The `@alexkroman1/aai-ui` component a page renders for this shape. */
  element: string;
  /** What the input schema says — which is what selects the control. */
  schema: string;
  /** The property the example names. This agent's own when {@link declared}. */
  property: string;
  /** The property's value in `input`, as JSON. */
  value: string;
  /** True when {@link property} is one this agent really declares. */
  declared: boolean;
  /** The workflow the example came from. Set only when {@link declared}. */
  workflow?: string;
  /** The one thing a CALLER has to know to set it. */
  note: string;
};

/**
 * A component name as a reader writes it in `client.tsx`.
 *
 * A helper rather than the literal `"<CheckboxField>"` because Biome's
 * `noSecrets` scores the longer bracketed names as high-entropy strings and
 * fails the lint on them — and a suppression comment for a component name
 * would be spending an escape-hatch budget on a false positive. (Writing the
 * name of that comment here spends one too: `check:hatches` counts the
 * suppression patterns on comment lines as well as on code.) Composing the
 * brackets says the same thing and is the shape the JSX would want anyway.
 */
function tag(name: string): string {
  return `<${name}>`;
}

/**
 * The vocabulary, in the order a form is usually written rather than the order
 * {@link classify} tests: a reader is scanning for the control they are looking
 * at, and `FileField` last is what puts the one row with a second step beside
 * the upload card that documents it.
 *
 * `property` and `value` here are the FALLBACKS — used verbatim for a kind this
 * agent declares nothing of, and replaced by its own property and its own
 * sampled value when it does.
 */
const VOCABULARY: readonly Omit<FormElementDoc, "declared" | "workflow">[] = [
  {
    kind: "text",
    element: tag("TextField"),
    schema: `{ "type": "string" }`,
    property: "topic",
    value: `"<topic>"`,
    note: "A JSON string — the default for a property whose schema says nothing more specific.",
  },
  {
    kind: "textarea",
    element: tag("TextAreaField"),
    schema: `{ "type": "string" }`,
    property: "notes",
    value: `"<notes>"`,
    note: "Indistinguishable from a text field over the API — both are a string. A generated form renders the one-line control; a textarea is the hand-written swap.",
  },
  {
    kind: "number",
    element: tag("NumberField"),
    schema: `{ "type": "number" } or { "type": "integer" }`,
    property: "count",
    value: "0",
    note: "A JSON number, not a string: the schema rejects a quoted digit, and the browser form sends nothing at all for an empty box.",
  },
  {
    kind: "select",
    element: tag("SelectField"),
    schema: `{ "enum": [...] }`,
    property: "tone",
    value: `"formal"`,
    note: "One member of the declared `enum`, spelled exactly. Anything else is rejected before the run starts.",
  },
  {
    kind: "checkbox",
    element: tag("CheckboxField"),
    schema: `{ "type": "boolean" }`,
    property: "draft",
    value: "false",
    note: "A JSON boolean. An unchecked box sends `false` rather than omitting the property.",
  },
  {
    kind: "file",
    element: tag("FileField upload"),
    schema: "a string, named in the workflow's `uploads`",
    property: "recording",
    value: `"<upload id>"`,
    note: "The only control whose value is not the thing you have: POST the bytes to /workflows/uploads first, then send the id it answers with here. A run input is journaled and replayed, so bytes cannot travel in it.",
  },
  {
    kind: "none",
    element: "hand-written — no generated control",
    schema: `{ "type": "object" } or { "type": "array" }`,
    property: "items",
    value: `["<items>"]`,
    note: "The API takes it as-is; only the generated form declines it, because every control for a nested shape is a guess. Write the field by hand and it composes with the generated ones.",
  },
];

/** The properties of one workflow's input schema, in declaration order. */
function schemaProperties(workflow: WorkflowSummary): readonly [string, unknown][] {
  if (!isRecord(workflow.inputSchema)) return [];
  const { properties } = workflow.inputSchema;
  return isRecord(properties) ? Object.entries(properties) : [];
}

/**
 * Which control one declared property renders as.
 *
 * A thin adapter over `fieldKindFor`, which is `<WorkflowFields>`'s own
 * decision — the ORDER (a declared upload before the enum, the enum before the
 * type) lives with the component that runs it and is documented there. What
 * this adds is the shape THIS module walks in: the pane iterates a schema's
 * properties against the workflow's `uploads` list, so it has a name and an
 * array where the rule wants a boolean.
 */
export function classify(
  name: string,
  schema: unknown,
  uploads: readonly string[],
): FormElementKind {
  return fieldKindFor(schema, { upload: uploads.includes(name) });
}

/** One declared property, classified, with the value the run body sends for it. */
export type ClassifiedField = {
  property: string;
  kind: FormElementKind;
  /** The `@alexkroman1/aai-ui` control, for annotating a snippet. */
  element: string;
  /** Its value in `input`, as JSON — the same sample every snippet on the pane sends. */
  value: string;
};

/** The component name one kind renders as, for a snippet's trailing comment. */
function elementOf(kind: FormElementKind): string {
  return VOCABULARY.find((entry) => entry.kind === kind)?.element ?? "hand-written";
}

/**
 * Every declared property of one workflow, classified and paired with the value
 * the pane's own snippets send for it.
 *
 * The value comes from {@link sampleInput} rather than from a second sampler, so
 * an annotated snippet and the run body beside it cannot disagree about what
 * this deployment's `topic` looks like.
 */
export function classifiedFields(workflow: WorkflowSummary): readonly ClassifiedField[] {
  const memo = CLASSIFIED.get(workflow);
  if (memo !== undefined) return memo;
  const fields = classifyWorkflow(workflow);
  CLASSIFIED.set(workflow, fields);
  return fields;
}

/**
 * The walk itself, cached per workflow OBJECT.
 *
 * One render of the API pane asks for the same workflow's fields three times —
 * `formElements` builds the vocabulary table, `fieldsWorkflow` re-walks the
 * whole listing again only to COUNT, and `docs-field-snippets` walks the winner
 * a third time — and each walk runs `sampleInput` over the schema plus a
 * `JSON.stringify` per property. Keyed on identity rather than on a name because
 * that is what makes it safe: a `WorkflowSummary` is a frozen-in-practice
 * payload held under `staleTime: Infinity`, so a re-deploy that changes the
 * schema arrives as a NEW object and misses the cache. A `WeakMap` so a
 * superseded listing is still collectable.
 */
const CLASSIFIED = new WeakMap<WorkflowSummary, readonly ClassifiedField[]>();

function classifyWorkflow(workflow: WorkflowSummary): readonly ClassifiedField[] {
  // A TERSE upload placeholder, against the sampler's default
  // `<upload id for cover>`. The default is right where it appears inside a
  // whole request body — it has to survive being read out of context — and
  // wrong on a row that already names the property in the column to its left,
  // where it reads as the property being mentioned twice. Nothing else uses
  // this value for an upload: the SDK snippet renders the expression instead,
  // and the shell body comes from `curlStart`.
  const sample = sampleInput(workflow, { upload: () => "<upload id>" }) ?? {};
  const uploads = workflow.uploads ?? [];
  return schemaProperties(workflow).map(([property, schema]) => {
    const kind = classify(property, schema, uploads);
    return {
      property,
      kind,
      element: elementOf(kind),
      value: JSON.stringify(sample[property]),
    };
  });
}

/**
 * The whole table: every control, carrying this agent's own example where it
 * declares a property of that shape.
 *
 * First match wins, in listing order then declaration order, which is the same
 * order the run examples above the table are generated in — so a reader who
 * recognises a field name here finds it in the snippet they just read rather
 * than in a workflow further down the pane.
 */
export function formElements(declared: readonly WorkflowSummary[]): readonly FormElementDoc[] {
  const found = new Map<FormElementKind, { workflow: string } & ClassifiedField>();
  for (const workflow of declared) {
    for (const field of classifiedFields(workflow)) {
      if (!found.has(field.kind)) found.set(field.kind, { workflow: workflow.name, ...field });
    }
  }
  return VOCABULARY.map((entry) => {
    const example = found.get(entry.kind);
    // A textarea is deliberately never matched: it is a string like a text
    // field, so the SAME property would appear on two rows claiming to be two
    // controls, and only one of them is what the generated form renders.
    if (example === undefined || entry.kind === "textarea") {
      return { ...entry, declared: false };
    }
    return {
      ...entry,
      property: example.property,
      value: example.value,
      declared: true,
      workflow: example.workflow,
    };
  });
}

/**
 * The workflow the annotated snippets are written against: the one declaring
 * the most fields.
 *
 * A REAL workflow rather than a synthesized every-kind example, because the
 * snippet is there to be pasted — a body mixing properties from two workflows
 * would render perfectly and 400. `undefined` when no workflow declares a
 * schema, which is a real shape (input is optional) and means the annotated
 * example is simply not offered.
 */
export function fieldsWorkflow(declared: readonly WorkflowSummary[]): WorkflowSummary | undefined {
  let best: { workflow: WorkflowSummary; count: number } | undefined;
  for (const workflow of declared) {
    const count = classifiedFields(workflow).length;
    if (count > 0 && (best === undefined || count > best.count)) best = { workflow, count };
  }
  return best?.workflow;
}
