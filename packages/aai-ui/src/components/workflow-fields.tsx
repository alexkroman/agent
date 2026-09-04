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
 * ## It covers SCALARS, and says so rather than guessing
 *
 * A string, number, integer, boolean or enum has one obvious control each. A
 * nested object or an array does not — every choice (a JSON textarea, a repeater,
 * a comma-separated string) is a guess about what the author meant, and a guess
 * that produces a value the schema then rejects is worse than no field at all.
 * So those are SKIPPED, and the fields for them are written by hand: every field
 * in this package is a plain named control, so a hand-written one composes with
 * a generated one inside the same {@link Form}.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import { useWorkflows } from "../use-workflows.ts";
import { useDeclareFieldsPending } from "./_form-readiness.ts";
import { CheckboxField, FileField, NumberField, SelectField, TextField } from "./form.tsx";

/** The slice of JSON Schema this reads. Everything else is ignored. */
type JsonSchemaProperty = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
};

type JsonObjectSchema = {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

/**
 * Render one field per scalar property of a workflow's input schema.
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
 * @param props - Field-set props.
 *
 * @public
 */
export function WorkflowFields({
  workflow,
}: {
  /**
   * The workflow whose input schema to render. A NAME is looked up here (one
   * `GET workflows`); a {@link WorkflowSummary} the page already holds fetches
   * nothing. `undefined` renders nothing, so a page may pass a selection
   * straight through before one is made.
   */
  workflow?: WorkflowSummary | string | undefined;
}) {
  // Unconditional, because a hook cannot be: the listing is only REQUESTED when
  // a name was passed, which is what keeps a page that already holds its
  // summaries from fetching them twice.
  const { workflows, loading } = useWorkflows(typeof workflow === "string" ? {} : { skip: true });
  const summary =
    typeof workflow === "string" ? workflows.find((entry) => entry.name === workflow) : workflow;
  // Tell the enclosing `<Form>` that its fields do not exist yet, so a click
  // before the lookup lands cannot submit an empty payload — the whole argument is
  // in `_form-readiness.ts`. `loading` rather than `!summary`: a name that matches
  // no workflow is a PERMANENT absence, and holding the form shut for it would
  // replace a bad error message with a form that never submits.
  useDeclareFieldsPending(loading);
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
      {Object.entries(schema.properties).map(([name, property]) => (
        <SchemaField
          key={name}
          name={name}
          property={property}
          required={required.has(name)}
          upload={uploads.has(name)}
        />
      ))}
    </>
  );
}

/** One property's control, or nothing when its type has no obvious one. */
function SchemaField({
  name,
  property,
  required,
  upload = false,
}: {
  name: string;
  property: JsonSchemaProperty;
  required: boolean;
  /** Declared in the workflow's `uploads` — a file picker, not a text box. */
  upload?: boolean;
}) {
  const label = humanize(name);
  // `hint` is only passed when there is one: an `undefined` here would be an
  // excess-property error under `exactOptionalPropertyTypes`.
  const hint = property.description === undefined ? {} : { hint: property.description };
  const defaults = property.default === undefined ? {} : { defaultValue: String(property.default) };

  // Before the enum and the type switch, because an upload property is a plain
  // string in the schema and would otherwise render as a text box asking a
  // person to type an id no person has.
  if (upload) {
    return <FileField name={name} label={label} required={required} upload {...hint} />;
  }

  if (Array.isArray(property.enum) && property.enum.length > 0) {
    return (
      <SelectField
        name={name}
        label={label}
        required={required}
        options={property.enum.map((value) => String(value))}
        {...hint}
        {...defaults}
      />
    );
  }

  const type = typeOf(property);
  switch (type) {
    case "boolean":
      return (
        <CheckboxField
          name={name}
          label={label}
          defaultChecked={property.default === true}
          {...hint}
        />
      );
    case "number":
    case "integer":
      return (
        <NumberField
          name={name}
          label={label}
          required={required}
          step={type === "integer" ? 1 : "any"}
          {...hint}
          {...defaults}
        />
      );
    case "string":
      return <TextField name={name} label={label} required={required} {...hint} {...defaults} />;
    default:
      // See the module doc: no honest control, so no control.
      return null;
  }
}

/** A property's type, taking the first non-null member of a union. */
function typeOf(property: JsonSchemaProperty): string | undefined {
  const { type } = property;
  if (typeof type === "string") return type;
  // `["string", "null"]` is how an optional-and-nullable field converts; the
  // control is the same one the non-null half wants.
  return Array.isArray(type) ? type.find((member) => member !== "null") : undefined;
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
