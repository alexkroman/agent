// Copyright 2026 the AAI authors. MIT license.
/**
 * Which control one property of a workflow's input schema renders as.
 *
 * `<WorkflowFields>` walks a workflow's `inputSchema` and picks a control per
 * property. This is that decision with nothing rendered — ONE function, called
 * by `SchemaField` itself, so a reader outside the component can ask the same
 * question and get the same answer.
 *
 * **Why it is published.** The rule is not derivable from the schema by
 * inspection: an upload property IS a plain `string` there, and the ORDER
 * matters in a way no reader can see. The studio's API pane documents the
 * form-to-JSON correspondence for every workflow app, and it was carrying a
 * hand-kept mirror of the switch below — "a declared upload beats everything,
 * then `enum`, then …" — with a comment admitting as much and a test pinning
 * the order to catch the drift. A copy that drifted would name a control the
 * reader cannot find on their own page. Nothing else could be done about it
 * while the decision was private, and the same reasoning already settled the
 * studio's SDK-subpath list: mirroring "would just move the drift somewhere
 * new".
 *
 * So a NEW control added to `<WorkflowFields>` is a new member of
 * {@link WorkflowFieldKind}, and every reader of the rule finds out from the
 * type rather than from a table somebody remembered to edit.
 */

import { isRecord } from "@alexkroman1/aai/utils";

/**
 * The control a schema property renders as inside `<WorkflowFields>`.
 *
 * `"none"` is not a control: it is the shape the generated form declines to
 * guess at — a nested object, an array — because every choice (a JSON
 * textarea, a repeater, a comma-separated string) is a guess about what the
 * author meant, and a guess producing a value the schema then rejects is worse
 * than no field. The API takes those shapes perfectly well; only the generated
 * form has nothing honest to draw, so the field is written by hand and
 * composes with the generated ones inside the same `<Form>`.
 *
 * There is deliberately no `"textarea"` member. A textarea is a string like a
 * text field is — the same value over the wire — so it is a hand-written swap
 * rather than a shape the schema can ask for.
 *
 * @public
 */
export type WorkflowFieldKind = "text" | "number" | "select" | "checkbox" | "file" | "none";

/**
 * A property's declared type, taking the first non-null member of a union.
 *
 * `["string", "null"]` is how an optional-and-nullable field converts; the
 * control is the one the non-null half wants. Not exported from the package
 * barrel — the published question is the KIND, and this is the one detail
 * `<WorkflowFields>` needs past it (an integer's `step`).
 */
export function schemaTypeOf(schema: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  const { type } = schema;
  if (typeof type === "string") return type;
  return Array.isArray(type) ? type.find((member) => member !== "null") : undefined;
}

/**
 * Which control `<WorkflowFields>` renders for one property of an input schema.
 *
 * @remarks
 * The ORDER is the contract, and it is the half a reader cannot infer:
 *
 * 1. **A declared upload wins outright.** It is a plain `string` in the schema
 *    — the id — so testing the type first would render a text box asking a
 *    person to type an id no person has. The declaration is the workflow's
 *    (`workflow({ uploads: [...] })`), not the schema's, precisely because a
 *    marker inside the schema would only work for the library that carried it.
 * 2. **Then a non-empty `enum`**, before the type switch: an enum of strings
 *    is a `string` too, and a select is the narrower, better control.
 * 3. **Then the type** — `boolean`, `number`/`integer`, `string`.
 * 4. **Anything else is `"none"`** rather than a guess. See
 *    {@link WorkflowFieldKind}.
 *
 * @example
 * ```ts
 * import { fieldKindFor, type WorkflowFieldKind } from "@alexkroman1/aai-ui";
 * import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
 *
 * function kindsOf(summary: WorkflowSummary): Record<string, WorkflowFieldKind> {
 *   const uploads = new Set(summary.uploads ?? []);
 *   const schema = summary.inputSchema as { properties?: Record<string, unknown> };
 *   return Object.fromEntries(
 *     Object.entries(schema.properties ?? {}).map(([name, property]) => [
 *       name,
 *       fieldKindFor(property, { upload: uploads.has(name) }),
 *     ]),
 *   );
 * }
 * ```
 *
 * @param schema - The property's JSON Schema, as `GET workflows` reports it.
 *   Anything that is not an object reads as `"none"`.
 * @param options - `upload` says the property is named in the workflow's own
 *   `uploads` declaration, which is what step 1 above tests.
 *
 * @public
 */
export function fieldKindFor(
  schema: unknown,
  options?: { upload?: boolean | undefined },
): WorkflowFieldKind {
  if (options?.upload === true) return "file";
  if (!isRecord(schema)) return "none";
  const { enum: choices } = schema;
  if (Array.isArray(choices) && choices.length > 0) return "select";
  switch (schemaTypeOf(schema)) {
    case "boolean":
      return "checkbox";
    case "number":
    case "integer":
      return "number";
    case "string":
      return "text";
    default:
      return "none";
  }
}
