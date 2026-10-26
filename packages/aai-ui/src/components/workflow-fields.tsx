// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * A form built from a workflow's declared input schema.
 *
 * `GET workflows` reports each workflow's `inputSchema` as JSON Schema — the
 * zod schema an author wrote in `agent.ts`, converted at listing time precisely
 * so a browser can read it. This is what reads it: one `<WorkflowFields>` and a
 * workflow's form matches its schema by construction, so adding a field to the
 * schema adds it to the page and nothing can drift.
 *
 * ## It covers SCALARS and two more shapes, and says so rather than guessing
 *
 * A string, number, integer, boolean or enum has one obvious control each. Most
 * nested objects and arrays do not — every choice (a JSON textarea, a repeater,
 * a comma-separated string) is a guess about what the author meant, and a guess
 * that produces a value the schema then rejects is worse than no field at all.
 * So those are SKIPPED, and the fields for them are written by hand: every field
 * in this package is a plain named control, so a hand-written one composes with
 * a generated one inside the same {@link Form}.
 *
 * Two non-scalar shapes DO have an honest control, and are rendered: an array
 * of strings as `<TextAreaField split="lines">` (one per line), and an object
 * of exactly `{ name: string, text: string }` as `<FileField read="text"
 * as="namedText">` (a draft, read in the browser). A page may also ask for
 * either by property name through `render`, for a schema that is one of those
 * but does not say so plainly. Both were the hand-written half of
 * `document-redline-workflow`'s mixed form, reshaped on submit; the fields
 * contribute the schema's shape now, so the form is all declared.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import { type JSX, useEffect } from "react";
import { useWorkflows } from "../use-workflows.ts";
import type { WorkflowAppLike, WorkflowNameOf } from "../workflow-def-types.ts";
import {
  fieldKindFor,
  schemaChoicesOf,
  schemaTypeOf,
  type WorkflowFieldRender,
} from "../workflow-field-kind.ts";
import { useDeclareFieldsPending } from "./_form-readiness.ts";
import {
  CheckboxField,
  FileField,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
} from "./form.tsx";

/** The slice of JSON Schema this reads. Everything else is ignored. */
type JsonSchemaProperty = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
};

/**
 * The object schema's own slice. `properties` values are `unknown` because a
 * listing from a library other than zod may carry a BOOLEAN schema (`true`,
 * legal JSON Schema for "anything") or `null`; each is read through `isRecord`
 * before anything reads a keyword off it.
 */
type JsonObjectSchema = {
  properties?: Record<string, unknown>;
  required?: string[];
};

/**
 * Props for {@link WorkflowFields}.
 *
 * @typeParam App - The agent, when the page names it
 *   (`<WorkflowFields<typeof agentDef> workflow="digest" />`): `workflow` is
 *   then a name the agent declares, checked. Left to its default, any string:
 *   `WorkflowNameOf<WorkflowAppLike>` is `string`. The default is the
 *   constraint rather than the hooks' `never` because this is ONE signature —
 *   a form has no def form to fall to, so there is no second overload for a
 *   `never` to hand the call on to.
 *
 * @input
 * @public
 */
export type WorkflowFieldsProps<App extends WorkflowAppLike = WorkflowAppLike> = {
  /**
   * The workflow whose input schema to render. A NAME is looked up here (one
   * `GET workflows`); a {@link WorkflowSummary} the page already holds fetches
   * nothing. `undefined` renders nothing, so a page may pass a selection
   * straight through before one is made.
   */
  workflow?: WorkflowSummary | WorkflowNameOf<App> | undefined;
  /**
   * The control to draw for a property, by name, where the schema alone does
   * not say — `{ mustCover: "lines", source: "namedText" }`. Beats the schema
   * for that property, never a declared upload. See `WorkflowFieldKind`.
   */
  render?: Readonly<Record<string, WorkflowFieldRender>> | undefined;
};

/**
 * Render one field per property of a workflow's input schema that has an
 * honest control — every scalar, an array of strings, a `{ name, text }` object.
 *
 * Pass the workflow's NAME and the schema is fetched here; pass a
 * {@link WorkflowSummary} you already hold and nothing is fetched. The name form
 * is the one a page usually wants — it is the same string the submit hook takes,
 * and the alternative is three lines (`useWorkflows()`, a `.find()` by name, and
 * folding that lookup's error into the form's) whose only product is this
 * component's argument.
 *
 * Renders nothing when the workflow declared no schema — a workflow with no
 * declared input takes anything, and a form for "anything" is not a form — and
 * nothing while a named lookup is still in flight, so the hand-written fields
 * beside it are not reordered when the schema lands.
 *
 * @example
 * ```tsx no-check
 * import { Form, SubmitButton, WorkflowFields, useWorkflowSubmit }
 *   from "@alexkroman1/aai-ui";
 * import type { transcribe } from "./agent.ts";
 *
 * function StartRun() {
 *   const { submitForm, pending, error } = useWorkflowSubmit<typeof transcribe>("transcribe");
 *   return (
 *     <Form onSubmit={submitForm} error={error}>
 *       <WorkflowFields workflow="transcribe" />
 *       <SubmitButton pending={pending}>Transcribe</SubmitButton>
 *     </Form>
 *   );
 * }
 * ```
 *
 * @param props - See {@link WorkflowFieldsProps}.
 *
 * @public
 */
export function WorkflowFields<App extends WorkflowAppLike = WorkflowAppLike>({
  workflow,
  render,
}: WorkflowFieldsProps<App>): JSX.Element | null {
  // Unconditional, because a hook cannot be: the listing is only REQUESTED when
  // a name was passed, which is what keeps a page that already holds its
  // summaries from fetching them twice.
  const { workflows, loading, error } = useWorkflows(
    typeof workflow === "string" ? {} : { skip: true },
  );
  const summary =
    typeof workflow === "string" ? workflows.find((entry) => entry.name === workflow) : workflow;
  // Tell the enclosing `<Form>` that its fields do not exist yet, so a click
  // before the lookup lands cannot submit an empty payload — the whole argument is
  // in `_form-readiness.ts`. `loading` rather than `!summary`: a name that matches
  // no workflow is a PERMANENT absence, and holding the form shut for it would
  // replace a bad error message with a form that never submits.
  useDeclareFieldsPending(loading);
  // That permanent absence is SAID, once the listing has answered: the string
  // form is the one the compiler cannot check (`<WorkflowFields<typeof agentDef>>`
  // is), and a typo'd name otherwise renders an empty form that submits `{}`
  // with nothing anywhere naming the typo. A listing that failed is the hook's
  // `error`, not a missing name, and is not reported here.
  const unknownName =
    typeof workflow === "string" && !loading && error === undefined && summary === undefined;
  const declared = workflows.map((entry) => entry.name).join(", ");
  useEffect(() => {
    if (!unknownName) return;
    console.warn(
      `[aai-ui] <WorkflowFields workflow=${JSON.stringify(workflow)}> matches no workflow ` +
        `the agent declares (${declared === "" ? "none listed" : declared}); it renders no ` +
        "fields. Check the name against agent({ workflows }).",
    );
  }, [unknownName, workflow, declared]);
  const schema = asObjectSchema(summary?.inputSchema);
  if (!schema?.properties) return null;
  const required = new Set(schema.required ?? []);
  // The workflow's own `uploads` declaration. It cannot be read off the schema:
  // an upload property IS a string there — the id — and the difference between
  // "type a recording id" and "choose a recording" is exactly what the author
  // declared and what the reader needs.
  const uploads = new Set(summary?.uploads ?? []);

  return (
    <>
      {Object.entries(schema.properties).map(([name, property]) =>
        // A boolean or null property schema is legal JSON Schema with nothing
        // to read off it — skipped like any other shape with no honest control,
        // where it used to throw reading `.description` off `null`.
        isRecord(property) ? (
          <SchemaField
            key={name}
            name={name}
            property={property as JsonSchemaProperty}
            required={required.has(name)}
            upload={uploads.has(name)}
            render={render?.[name]}
          />
        ) : null,
      )}
    </>
  );
}

/** One property's control, or nothing when its type has no obvious one. */
function SchemaField({
  name,
  property,
  required,
  upload = false,
  render,
}: {
  name: string;
  property: JsonSchemaProperty;
  required: boolean;
  /** Declared in the workflow's `uploads` — a file picker, not a text box. */
  upload?: boolean;
  /** The page's own choice for this property, when it made one. */
  render?: WorkflowFieldRender | undefined;
}) {
  const label = humanize(name);
  // `hint` is only passed when there is one: an `undefined` here would be an
  // excess-property error under `exactOptionalPropertyTypes`.
  const hint = property.description === undefined ? {} : { hint: property.description };
  const defaults = property.default === undefined ? {} : { defaultValue: String(property.default) };

  // WHICH control is `fieldKindFor`'s decision, published so the studio's API
  // pane documents this exact rule rather than a hand-kept mirror of it — the
  // ordering argument (an upload before the type; an enum before it too) lives
  // there, in one place. What stays here is how each kind is DRAWN.
  switch (fieldKindFor(property, { upload, render })) {
    case "file":
      return <FileField name={name} label={label} required={required} upload {...hint} />;
    case "lines":
      // One entry per line. `required` on a textarea refuses an empty one,
      // which is what a required `string[]` means after blank lines go.
      return (
        <TextAreaField
          name={name}
          label={label}
          required={required}
          split="lines"
          rows={3}
          {...hint}
        />
      );
    case "namedText":
      return (
        <FileField
          name={name}
          label={label}
          required={required}
          read="text"
          as="namedText"
          {...hint}
        />
      );
    case "select": {
      const choices = schemaChoicesOf(property) ?? [];
      // A `<select>` can only hold strings, so a numeric set (`z.literal([1, 2])`,
      // `{ type: "number", enum: [1, 2] }`) is marked for `collectValues` to
      // read back as NUMBERS — submitted as `"1"`, the schema refused every
      // choice the form offered.
      const numeric = choices.length > 0 && choices.every((value) => typeof value === "number");
      return (
        <SelectField
          name={name}
          label={label}
          required={required}
          options={choices.map((value) => String(value))}
          {...omitUndefined({ "data-aai-value": numeric ? "number" : undefined })}
          {...hint}
          {...defaults}
        />
      );
    }
    case "checkbox":
      return (
        <CheckboxField
          name={name}
          label={label}
          defaultChecked={property.default === true}
          {...hint}
        />
      );
    case "number":
      return (
        <NumberField
          name={name}
          label={label}
          required={required}
          // The one detail past the kind: integer and number are one control,
          // and only the step differs.
          step={schemaTypeOf(property) === "integer" ? 1 : "any"}
          {...hint}
          {...defaults}
        />
      );
    case "text":
      return <TextField name={name} label={label} required={required} {...hint} {...defaults} />;
    default:
      // See the module doc: no honest control, so no control.
      return null;
  }
}

/** The listing's `unknown` schema as the object shape this reads, when it is one. */
function asObjectSchema(schema: unknown): JsonObjectSchema | undefined {
  return isRecord(schema) ? (schema as JsonObjectSchema) : undefined;
}

/**
 * A property name as a label — `recordingId` → `Recording id`.
 *
 * A default, not a policy: a schema whose labels matter should carry a
 * `.describe()`, and an author who wants exact control writes the field.
 */
function humanize(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
