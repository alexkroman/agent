// Copyright 2026 the AAI authors. MIT license.
/**
 * The walk a provider-compat rewrite runs over a tool's JSON Schema, and
 * nothing about any provider — `_tool-schema-compat.ts` holds the rules and
 * says which model gets which, and `_gateway-tool-schema.ts` is the middleware
 * that applies them.
 *
 * It is its own module because the two halves fail differently. A rule is a
 * claim about one provider's subset, revised whenever a gateway is measured;
 * this is a claim about JSON Schema itself, and about two properties every rule
 * depends on and no rule can restore once broken:
 *
 * **Identity when nothing changed.** This runs on every request of every turn,
 * so a schema needing no rewrite must allocate nothing and must be handed back
 * by reference — at every level, so that an untouched `properties` map is the
 * same object and the tool, and then `params`, can be handed back too. That is
 * what {@link SchemaDraft} buys: a rule reads and writes through it, and the
 * node is COPIED on the first edit that actually changes something and not
 * before. A rule that inspects a clean node and does nothing costs one closure.
 *
 * **A schema position is not any nested object.** The walk descends through the
 * keywords below and no others, which is a deliberate narrowing of the walk it
 * replaced: that one recursed into every nested object, so an author's
 * `default` or `const` whose VALUE happened to be shaped like a schema had
 * keywords deleted out of it. Those are the data a tool receives, not a schema
 * — and the lossy Gemini layer does not merely delete from a node, it writes a
 * `description` into it, which in an `enum` entry would corrupt the value the
 * model has to send back verbatim.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { JSONSchema7 } from "json-schema";

/**
 * One schema node, mid-rewrite — what a rule reads and edits instead of the
 * record itself, so the walk can keep the identity contract in the module doc.
 */
interface SchemaDraft {
  /** The node's current value for `key` — a previous rule's edit included. */
  get(key: string): unknown;
  /** Whether the key is present, which `get` cannot answer for `null`/`false`. */
  has(key: string): boolean;
  /** Write `key`. A write of the value already there is not a change. */
  set(key: string, value: unknown): void;
  /** Remove `key`. Removing an absent key is not a change. */
  remove(key: string): void;
  /**
   * Record a constraint this node no longer states in a keyword. Notes are
   * merged into `description` once, after every rule has run — a model reads
   * the prose, so a dropped `minLength` is still information it can use, where
   * a silently deleted one makes the tool call less accurate.
   */
  note(text: string): void;
}

interface DraftHandle extends SchemaDraft {
  /** Merge any notes into `description` and answer the finished node. */
  finish(): Record<string, unknown>;
}

function createDraft(source: Record<string, unknown>): DraftHandle {
  let copy: Record<string, unknown> | undefined;
  const notes: string[] = [];
  const current = (): Record<string, unknown> => copy ?? source;
  const mutable = (): Record<string, unknown> => {
    // The copy the identity contract turns on: taken here, by the first edit
    // that changes something, and never by a rule that only looked.
    copy ??= { ...source };
    return copy;
  };
  return {
    get: (key) => current()[key],
    has: (key) => key in current(),
    set(key, value) {
      if (Object.is(current()[key], value)) return;
      mutable()[key] = value;
    },
    remove(key) {
      if (!(key in current())) return;
      delete mutable()[key];
    },
    note(text) {
      notes.push(text);
    },
    finish() {
      if (notes.length === 0) return current();
      const existing = current().description;
      const prefix = typeof existing === "string" && existing !== "" ? `${existing}\n` : "";
      mutable().description = `${prefix}constraints: ${notes.join(", ")}`;
      return current();
    },
  };
}

/** A rewrite applied to every schema node, bottom-up. */
export type SchemaRule = (node: SchemaDraft) => void;

/** Keywords whose value IS a schema — the module doc's second property. */
const SUBSCHEMA_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/** Keywords whose value is an ARRAY of schemas (`items` in its tuple form too). */
const SUBSCHEMA_LIST_KEYS = new Set(["allOf", "anyOf", "items", "oneOf", "prefixItems"]);

/**
 * Keywords whose value is a MAP of schemas.
 *
 * `dependencies` is deliberately absent: draft-07 lets its values be either a
 * schema or an array of property NAMES, and walking a name list as if it were
 * a tuple of schemas is the mistake this table exists to prevent.
 */
const SUBSCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

function rewriteList(values: readonly unknown[], rules: readonly SchemaRule[]): readonly unknown[] {
  const out = values.map((value) => rewriteNode(value, rules));
  return out.some((value, i) => value !== values[i]) ? out : values;
}

function rewriteMap(
  value: Record<string, unknown>,
  rules: readonly SchemaRule[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    const next = rewriteNode(child, rules);
    if (next !== child) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

function rewriteChild(key: string, child: unknown, rules: readonly SchemaRule[]): unknown {
  if (SUBSCHEMA_MAP_KEYS.has(key)) return isRecord(child) ? rewriteMap(child, rules) : child;
  if (SUBSCHEMA_LIST_KEYS.has(key) && Array.isArray(child)) return rewriteList(child, rules);
  if (SUBSCHEMA_KEYS.has(key)) return rewriteNode(child, rules);
  return child;
}

function rewriteNode(value: unknown, rules: readonly SchemaRule[]): unknown {
  if (!isRecord(value)) return value;
  const draft = createDraft(value);
  for (const [key, child] of Object.entries(value)) {
    const next = rewriteChild(key, child, rules);
    if (next !== child) draft.set(key, next);
  }
  // Bottom-up: every rule sees children that are already rewritten, so a rule
  // that MOVES a child (`prefixItems` into `items`) moves the rewritten one.
  for (const rule of rules) rule(draft);
  return draft.finish();
}

/**
 * Apply `rules` to a tool input schema and every schema nested in it.
 *
 * Returns the input by IDENTITY when no rule changed anything, at every level —
 * so a schema that is already acceptable (every tool at all, once the gateway
 * accepts standard JSON Schema) allocates nothing and leaves `params`
 * untouched. That matters because this runs on every request of every turn.
 */
export function rewriteToolSchema(schema: JSONSchema7, rules: readonly SchemaRule[]): JSONSchema7 {
  return rewriteNode(schema, rules) as JSONSchema7;
}
