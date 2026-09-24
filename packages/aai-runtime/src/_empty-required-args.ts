// Copyright 2026 the AAI authors. MIT license.
/**
 * A tool call whose REQUIRED text argument is blank is refused before it runs.
 *
 * A voice model sometimes calls a tool before the caller has supplied
 * everything it needs, filling the gap with `""` — a lookup keyed on two
 * fields, issued with one of them empty. That call cannot succeed: the tool
 * (or the client a relay forwards it to) answers with an error, and a backend
 * that counts tool errors counts it against the session. The system prompt
 * already forbids placeholders; this makes the rule structural.
 *
 * The refusal is an ordinary model-recoverable failure
 * (`serializeToolFailure`), so it takes every path a returned `ToolFailure`
 * takes — the model's copy, the recorded `role: "tool"` message, the
 * `tool.completed` frame — and names each blank field so the model's next move
 * is to ask for it.
 *
 * **Only a PLAIN string-typed required field is checked.** Optional fields are
 * the tool's to default. A field that admits another type (a number, an
 * object, a union) is left to the tool's own validation, as is one with an
 * `enum` or `const`, where `""` may be a listed value. A NULLABLE string
 * (`["string", "null"]`, or an `anyOf` of a string and `null`) still counts,
 * and `null` is accepted for it — that is the schema's own spelling of "none";
 * a blank string is not.
 */

import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

type StringKind = "string" | "nullable-string";

const isNullSchema = (s: JSONSchema7Definition): boolean =>
  typeof s === "object" && s.type === "null";

/** An `anyOf`/`oneOf` that is one plain string branch, optionally beside `null`. */
function unionKind(branches: readonly JSONSchema7Definition[]): StringKind | undefined {
  const nonNull = branches.filter((b) => !isNullSchema(b));
  if (nonNull.length !== 1 || stringKind(nonNull[0]) !== "string") return;
  return nonNull.length < branches.length ? "nullable-string" : "string";
}

/**
 * How a property's schema reads for this check: `"string"` when a plain string
 * is the only thing it admits, `"nullable-string"` when `null` is admitted
 * beside it, otherwise `undefined` (not checked).
 */
function stringKind(prop: JSONSchema7Definition | undefined): StringKind | undefined {
  if (prop === undefined || typeof prop === "boolean") return;
  if (prop.enum !== undefined || prop.const !== undefined) return;
  const branches = prop.anyOf ?? prop.oneOf;
  if (branches !== undefined) return prop.type === undefined ? unionKind(branches) : undefined;
  const types = typeof prop.type === "string" ? [prop.type] : (prop.type ?? []);
  const nonNull = types.filter((t) => t !== "null");
  if (nonNull.length !== 1 || nonNull[0] !== "string") return;
  return nonNull.length < types.length ? "nullable-string" : "string";
}

function isBlank(value: unknown, kind: StringKind): boolean {
  if (value === null && kind === "nullable-string") return false;
  return typeof value !== "string" || value.trim() === "";
}

/**
 * The required, plain-string-typed fields of `parameters` that `args` leaves
 * missing, non-string, or blank after trimming — in the schema's `required`
 * order. Empty when the call may run.
 */
export function emptyRequiredStrings(
  args: Readonly<Record<string, unknown>>,
  parameters: JSONSchema7,
): string[] {
  const props = parameters.properties ?? {};
  const out: string[] = [];
  for (const field of parameters.required ?? []) {
    const kind = stringKind(props[field]);
    if (kind === undefined) continue;
    if (isBlank(Object.hasOwn(args, field) ? args[field] : undefined, kind)) out.push(field);
  }
  return out;
}

/**
 * The serialized failure a refused call answers with, naming every blank field.
 *
 * `fields` is never empty — a caller only builds this after
 * {@link emptyRequiredStrings} found at least one.
 */
export function emptyRequiredFailure(fields: readonly string[], toolName: string): string {
  const named = fields.map((f) => `"${f}"`).join(", ");
  const [verb, pronoun] = fields.length === 1 ? ["is", "it"] : ["are", "them"];
  return serializeToolFailure(
    `${named} ${verb} empty — ask the caller for ${pronoun} before calling ${toolName}.`,
  );
}
