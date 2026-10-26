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
 * So a NEW control added to `<WorkflowFields>` is a new value of
 * {@link WorkflowFieldKind}. The set is open, so that addition is not a break:
 * a reader's `switch` keeps a `default` and treats a kind it does not know the
 * way it treats `"none"`.
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
 * Two NON-scalar shapes do have an honest control, and are the two members
 * past the scalars: `"lines"` is `<TextAreaField split="lines">` for an array
 * of strings (one per line), and `"namedText"` is `<FileField read="text"
 * as="namedText">` for an object of exactly `{ name: string, text: string }` —
 * a draft, a config, read in the browser and journaled with the input. Both
 * were the hand-written half of `document-redline-workflow`'s mixed form; a
 * page may also ASK for either by name through `render`.
 *
 * Open (`| (string & {})`): a control added later is a new value, so read an
 * unknown kind as `"none"`.
 *
 * @public
 */
export type WorkflowFieldKind =
  | "text"
  | "number"
  | "select"
  | "checkbox"
  | "file"
  | "lines"
  | "namedText"
  | "none"
  | (string & {});

/**
 * The kinds a page may ask `<WorkflowFields render>` for by property name —
 * the two non-scalar controls, which a schema cannot always say it wants.
 *
 * @public
 */
export type WorkflowFieldRender = "lines" | "namedText";

/**
 * Whether `schema` is an object of exactly `{ name: string, text: string }`,
 * both required — the one object shape with a declared control.
 */
function isNamedTextSchema(schema: Record<string, unknown>): boolean {
  if (schemaTypeOf(schema) !== "object" || !isRecord(schema.properties)) return false;
  const keys = Object.keys(schema.properties);
  if (keys.length !== 2 || !keys.includes("name") || !keys.includes("text")) return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return (
    required.includes("name") &&
    required.includes("text") &&
    schemaTypeOf(schema.properties.name) === "string" &&
    schemaTypeOf(schema.properties.text) === "string"
  );
}

/** Whether `schema` is an array of strings. */
function isStringListSchema(schema: Record<string, unknown>): boolean {
  return schemaTypeOf(schema) === "array" && schemaTypeOf(schema.items) === "string";
}

/** The members of a schema's `anyOf`/`oneOf`, when it is a union at all. */
function unionMembersOf(schema: Record<string, unknown>): readonly unknown[] | undefined {
  const members = schema.anyOf ?? schema.oneOf;
  return Array.isArray(members) ? members : undefined;
}

/** `{ type: "null" }` — the half of a nullable union that wants no control. */
function isNullSchema(member: unknown): boolean {
  return isRecord(member) && member.type === "null";
}

/**
 * The schema with a NULLABLE union unwrapped: `anyOf: [X, { type: "null" }]`
 * reads as `X`, the way `type: ["string", "null"]` reads as `"string"`.
 *
 * Zod 4 converts `z.enum([…]).nullable()` (and any nullable whose inner schema
 * carries keywords of its own) to that `anyOf`, where a bare
 * `z.string().nullable()` becomes the type list — so a required nullable enum
 * used to reach the type switch with no `type` at all, render NO control, and
 * leave a required property out of every submission. A union with two or more
 * non-null members is some other shape and is answered as itself; a schema
 * that is not an object has no answer.
 *
 * Not exported from the package barrel, like {@link schemaTypeOf}.
 */
export function nonNullSchemaOf(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema)) return undefined;
  const members = unionMembersOf(schema);
  if (members === undefined) return schema;
  const rest = members.filter((member) => !isNullSchema(member));
  return rest.length === 1 ? nonNullSchemaOf(rest[0]) : schema;
}

/**
 * The choices a select renders for `schema`, or undefined when it is not a
 * closed set: a non-empty `enum`, or the `const` of each member of a union of
 * literals — which is how zod 4 converts `z.union([z.literal("p"),
 * z.literal("q")])`, where `z.enum` and `z.literal([1, 2])` convert to `enum`.
 * The values keep their own type (`[1, 2]` stays numeric), so the control can
 * submit what the schema declared.
 *
 * Not exported from the package barrel, like {@link schemaTypeOf}.
 */
export function schemaChoicesOf(schema: unknown): readonly unknown[] | undefined {
  const inner = nonNullSchemaOf(schema);
  if (inner === undefined) return undefined;
  if (Array.isArray(inner.enum)) return inner.enum.length > 0 ? inner.enum : undefined;
  const members = unionMembersOf(inner)?.filter((member) => !isNullSchema(member));
  if (members === undefined || members.length === 0) return undefined;
  const consts = members.map((member) => (isRecord(member) ? member.const : undefined));
  return consts.every((value) => value !== undefined) ? consts : undefined;
}

/**
 * A property's declared type, taking the first non-null member of a union.
 *
 * `["string", "null"]` is how an optional-and-nullable field converts; the
 * control is the one the non-null half wants. A nullable `anyOf` is read the
 * same way ({@link nonNullSchemaOf}). Not exported from the package barrel —
 * the published question is the KIND, and this is the one detail
 * `<WorkflowFields>` needs past it (an integer's `step`).
 */
export function schemaTypeOf(schema: unknown): string | undefined {
  const inner = nonNullSchemaOf(schema);
  if (inner === undefined) return undefined;
  const { type } = inner;
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
 * 2. **Then a closed set of choices**, before the type switch: a non-empty
 *    `enum`, or a union of `const` literals (`schemaChoicesOf`) — an enum
 *    of strings is a `string` too, and a select is the narrower, better
 *    control. A nullable union (`anyOf: [X, { type: "null" }]`) is read as `X`
 *    throughout, as `type: [X, "null"]` already was.
 * 3. **Then the type** — `boolean`, `number`/`integer`, `string`.
 * 4. **Then the two non-scalar shapes with a control** — an array of strings
 *    is `"lines"`, an object of exactly `{ name: string, text: string }` is
 *    `"namedText"`. A page may also name either through `render`, which beats
 *    the schema for that property (it is the author saying what the shape
 *    means) but never a declared upload.
 * 5. **Anything else is `"none"`** rather than a guess. See
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
 *   `uploads` declaration, which is what step 1 above tests; `render` is the
 *   page's own choice for the property (`<WorkflowFields render>`).
 *
 * @public
 */
export function fieldKindFor(
  schema: unknown,
  options?: { upload?: boolean | undefined; render?: WorkflowFieldRender | undefined },
): WorkflowFieldKind {
  if (options?.upload === true) return "file";
  if (options?.render !== undefined) return options.render;
  // The nullable half is unwrapped ONCE, here: a required `z.enum().nullable()`
  // is an `anyOf` the type switch cannot read, and the control is the one its
  // non-null member wants.
  const inner = nonNullSchemaOf(schema);
  if (inner === undefined) return "none";
  if (schemaChoicesOf(inner) !== undefined) return "select";
  switch (schemaTypeOf(inner)) {
    case "boolean":
      return "checkbox";
    case "number":
    case "integer":
      return "number";
    case "string":
      return "text";
    case "array":
      return isStringListSchema(inner) ? "lines" : "none";
    case "object":
      return isNamedTextSchema(inner) ? "namedText" : "none";
    default:
      return "none";
  }
}
