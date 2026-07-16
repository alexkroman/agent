// Copyright 2026 the AAI authors. MIT license.
/**
 * Best-effort coercion of LLM-produced tool arguments toward the types the
 * tool's JSON Schema declares.
 *
 * Voice-mode LLMs routinely stringify scalars ("1500" for a price cap, "true"
 * for a boolean filter). Loose schemas (union types, untyped values) accept
 * those strings, so they flow through to the tool — and to any harness
 * observing the call — as the wrong JSON type. This module fixes the
 * unambiguous cases at the call boundary:
 *
 * - a string that is exactly `true`/`false` becomes a boolean when the
 *   property's schema allows booleans (or declares no types at all);
 * - a canonical numeric string becomes a number when the schema allows
 *   numbers/integers (or declares no types at all).
 *
 * A property whose schema allows ONLY strings is never touched, so free-text
 * fields ("query": "1984") stay verbatim. Coercion is shallow — benchmark and
 * real-world tool args are overwhelmingly flat objects.
 */

import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

function addTypeNames(out: Set<string>, t: JSONSchema7["type"]): void {
  if (typeof t === "string") out.add(t);
  else if (Array.isArray(t)) for (const x of t) out.add(x);
}

function addEnumValueTypes(out: Set<string>, values: JSONSchema7["enum"]): void {
  for (const v of values ?? []) {
    const t = typeof v;
    if (t === "number" || t === "boolean" || t === "string") out.add(t);
  }
}

/**
 * Collect the primitive type names a property schema admits, walking
 * `type` (string or array) plus `anyOf`/`oneOf` branches and inferring from
 * `enum` values. Returns `null` when the schema carries no type information
 * (treat as "anything goes").
 */
function allowedTypes(prop: JSONSchema7Definition | undefined): ReadonlySet<string> | null {
  if (prop === undefined || typeof prop === "boolean") return null;
  const out = new Set<string>();
  const queue: JSONSchema7Definition[] = [prop];
  for (let s = queue.pop(); s !== undefined; s = queue.pop()) {
    if (typeof s === "boolean") continue;
    addTypeNames(out, s.type);
    addEnumValueTypes(out, s.enum);
    if (s.anyOf) queue.push(...s.anyOf);
    if (s.oneOf) queue.push(...s.oneOf);
  }
  return out.size > 0 ? out : null;
}

/** Canonical numeric string: optional sign, digits, optional decimal part. */
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

function coerceValue(value: string, types: ReadonlySet<string> | null): unknown {
  const allows = (t: string): boolean => types === null || types.has(t);
  // A string-only property is authoritative — never rewrite free text.
  if (!(allows("boolean") || allows("number") || allows("integer"))) return value;
  if (allows("boolean") && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if ((allows("number") || allows("integer")) && NUMERIC_RE.test(value)) {
    const n = Number(value);
    const integerOnly = types?.has("integer") === true && types?.has("number") !== true;
    if (Number.isFinite(n) && !(integerOnly && !Number.isInteger(n))) return n;
  }
  return value;
}

/**
 * Return `args` with unambiguous scalar strings coerced to the types the
 * tool's parameter schema admits. Non-string values and unknown keys pass
 * through untouched; the input object is never mutated.
 */
export function coerceToolArgs(
  args: Readonly<Record<string, unknown>>,
  parameters: JSONSchema7,
): Readonly<Record<string, unknown>> {
  const props = parameters.properties;
  if (!props || typeof props !== "object") return args;
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const coerced = coerceValue(value, allowedTypes(props[key]));
    if (coerced !== value) {
      out ??= { ...args };
      out[key] = coerced;
    }
  }
  return out ?? args;
}
