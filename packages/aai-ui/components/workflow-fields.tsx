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

import type { WorkflowSummary } from "@alexkroman1/aai";
import { CheckboxField, NumberField, SelectField, TextField } from "./form.tsx";

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
 * Renders nothing when the workflow declared no schema — a workflow with no
 * declared input takes anything, and a form for "anything" is not a form.
 *
 * @example
 * ```tsx
 * import { Form, SubmitButton, WorkflowFields, useWorkflows, useWorkflowSubmit }
 *   from "@alexkroman1/aai-ui";
 *
 * function StartRun() {
 *   const { workflows } = useWorkflows();
 *   const { submit, pending, error } = useWorkflowSubmit("transcribe");
 *   const transcribe = workflows.find((w) => w.name === "transcribe");
 *   return (
 *     <Form onSubmit={(values) => submit(values)} error={error}>
 *       <WorkflowFields workflow={transcribe} />
 *       <SubmitButton pending={pending}>Transcribe</SubmitButton>
 *     </Form>
 *   );
 * }
 * ```
 *
 * @public
 */
export function WorkflowFields({ workflow }: { workflow?: WorkflowSummary | undefined }) {
  const schema = asObjectSchema(workflow?.inputSchema);
  if (!schema?.properties) return null;
  const required = new Set(schema.required ?? []);

  return (
    <>
      {Object.entries(schema.properties).map(([name, property]) => (
        <SchemaField key={name} name={name} property={property} required={required.has(name)} />
      ))}
    </>
  );
}

/** One property's control, or nothing when its type has no obvious one. */
function SchemaField({
  name,
  property,
  required,
}: {
  name: string;
  property: JsonSchemaProperty;
  required: boolean;
}) {
  const label = humanize(name);
  // `hint` is only passed when there is one: an `undefined` here would be an
  // excess-property error under `exactOptionalPropertyTypes`.
  const hint = property.description === undefined ? {} : { hint: property.description };
  const defaults = property.default === undefined ? {} : { defaultValue: String(property.default) };

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

  switch (typeOf(property)) {
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
          step={typeOf(property) === "integer" ? 1 : "any"}
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
  return schema !== null && typeof schema === "object" ? (schema as JsonObjectSchema) : undefined;
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
