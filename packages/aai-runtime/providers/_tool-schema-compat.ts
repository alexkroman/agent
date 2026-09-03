// Copyright 2026 the AAI authors. MIT license.
/**
 * The rewrites a tool's JSON Schema needs before a given model on the
 * AssemblyAI LLM Gateway will accept it: one rule per keyword, and which model
 * gets which. `_tool-schema-walk.ts` is the walk that applies a rule to every
 * schema node, and `_gateway-tool-schema.ts` the middleware whose doc carries
 * how the defect presents and why it is middleware.
 *
 * ## Two layers, and only one of them is free
 *
 * - **{@link GATEWAY_SCHEMA_RULES}** — `$schema` and `propertyNames`, removed
 *   for EVERY model. Neither keyword carries information a model uses, so the
 *   rewrite costs nothing and applies unconditionally. Both were isolated by
 *   bisecting a captured request body against the live gateway, and both are
 *   verified accepted by OpenAI, Claude and Qwen.
 * - **{@link GEMINI_SCHEMA_RULES}** — the same two, plus the further
 *   restrictions of Gemini's function-calling subset, and every one of them is
 *   LOSSY: a constraint moves out of a keyword and into the `description`, or
 *   (`additionalProperties`) goes away. That is why this layer is selected by
 *   MODEL ID where the first is not. Applying it to a model that accepts
 *   standard JSON Schema would trade a working tool for a vaguer one.
 *
 * **Model-sniffing is what the middleware's doc argues against, and this does
 * not contradict it.** The argument there is that an unconditional rewrite
 * cannot silently miss "whichever Gemini id someone configures next" — true,
 * and it is why the two verified keywords stay unconditional. It only holds
 * for a rewrite that costs nothing. For a lossy one the trade inverts: a miss
 * leaves that model exactly where it is today (rejected, which is the open
 * defect), while a false positive degrades every tool on a model that was
 * working. {@link toolSchemaRules} therefore matches `gemini` or `google`
 * anywhere in the id, which covers all seven ids the gateway advertises
 * (`gemini-2.5-flash` … `gemini-3.6-flash`) and any provider-prefixed
 * spelling.
 *
 * ## What the Gemini layer is, and is NOT, evidence for
 *
 * The keyword list is taken from [Mastra's][mastra] `GoogleSchemaCompatLayer`
 * (MIT), which is a production layer over the same subset — Gemini's
 * `FunctionDeclaration.parameters` is an OpenAPI 3.0 Schema Object, not JSON
 * Schema. **None of it is verified against this gateway**: there is no
 * credential in CI, so what the specs beside this file assert is the
 * TRANSFORM, never the gateway's acceptance. What IS verified here is the
 * other half of the question — what our own conversion can actually emit —
 * measured by running `z.toJSONSchema(schema, { io: "input" })`, the call
 * `toToolJsonSchema` makes, over the zod vocabulary a tool author uses. Every
 * rule below names the emission it exists for; a rule with no such emission
 * was left out rather than carried over on faith.
 *
 * That measurement is also why the rules only ever REMOVE a keyword or
 * restate one inside standard JSON Schema. Mastra additionally emits
 * `nullable: true` (OpenAPI 3.0, not JSON Schema) and rewrites a typeless
 * node into a five-branch `anyOf`. Both ADD to a request whose failure mode is
 * a 500 naming nothing, so neither is here: unverified removal degrades a tool,
 * unverified addition can keep the model unusable while looking like a fix.
 *
 * ## Known gaps
 *
 * Named, because "not exhaustive" is what the previous version of this said
 * and it left the next reader to re-derive the list:
 *
 * - **`$ref` / `$defs`.** Reused sub-schemas are INLINED by our conversion
 *   (measured), so a `$ref` arises only from a recursive schema — where the
 *   only rewrites available are lossy (inline one level and re-emit the ref,
 *   or collapse to `{ type: "object" }`, both of which Mastra does). A
 *   recursive tool parameter is rare and a wrong collapse is silent, so it is
 *   left alone.
 * - **A typeless node.** `z.any()` / `z.unknown()` convert to `{}`, and
 *   Gemini's `Schema` wants a `type`. Guessing one changes what the model
 *   sends; the permissive `anyOf` is an addition, per above.
 * - **`type: "null"`** on its own (`z.null()`), which the subset cannot
 *   express at all.
 *
 * [mastra]: https://github.com/mastra-ai/mastra/tree/main/packages/schema-compat
 */

import type { SchemaRule } from "./_tool-schema-walk.ts";

/**
 * `$schema` — emitted at the root of every zod-derived tool schema (measured:
 * `z.toJSONSchema` tags its output with the 2020-12 dialect URI) — and
 * `propertyNames`, which is how `z.record(z.string(), …)` serializes. Both
 * answered 500 on the gateway's Gemini path; neither says anything a model
 * uses, which is why this one rule is unconditional.
 */
const dropGatewayUnsupported: SchemaRule = (node) => {
  node.remove("$schema");
  node.remove("propertyNames");
};

/**
 * `additionalProperties` is not in the OpenAPI 3.0 Schema Object, so Gemini has
 * nowhere to put it. Removing it opens a `z.strictObject` back up; the model
 * rarely invents a key, and our own validation still refuses one if it does.
 *
 * Bisecting the original 500 showed removing this did NOT fix it, so it stays
 * for every other model — this rule is why the two layers are separate.
 * Measured emissions: `false` from `z.strictObject`, and a SCHEMA (not a
 * boolean) from `z.record(…)`, whose value type lands here.
 */
const dropAdditionalProperties: SchemaRule = (node) => {
  node.remove("additionalProperties");
};

/** The only `format` values Gemini documents for a STRING. */
const GEMINI_STRING_FORMATS = new Set(["date-time", "enum"]);

/**
 * String constraints, folded into the description.
 *
 * `format` is the one Gemini partly supports, so a supported value survives and
 * every other (`email`, `uri`, `uuid`, `date` — all measured emissions of
 * `z.email()`, `z.url()`, `z.uuid()`, `z.iso.date()`) becomes prose.
 *
 * **`pattern` always goes, and that is not merely "unsupported".** Zod emits a
 * pattern BESIDE each of those formats, and its email pattern opens
 * `^(?!\.)(?!.*\.\.)` — lookahead, which RE2 (Google's regex engine) does not
 * implement, so the pattern cannot compile on the far side however the keyword
 * is treated. A pattern sitting next to a `format` restates it, so it is
 * dropped silently there; a hand-written one is the only information the node
 * carries and becomes prose.
 *
 * `minLength`/`maxLength` are accepted by Gemini's schema, and Mastra's layer
 * folds them anyway on the ground that the model does not RESPECT them and does
 * respect a description. That claim is theirs and is not measured here; the
 * fold costs a keyword the model ignores either way.
 */
const foldStringConstraints: SchemaRule = (node) => {
  const minLength = node.get("minLength");
  if (typeof minLength === "number") {
    node.note(`minimum length ${minLength}`);
    node.remove("minLength");
  }
  const maxLength = node.get("maxLength");
  if (typeof maxLength === "number") {
    node.note(`maximum length ${maxLength}`);
    node.remove("maxLength");
  }
  const format = node.get("format");
  if (typeof format === "string" && !GEMINI_STRING_FORMATS.has(format)) {
    node.note(`a valid ${format}`);
    node.remove("format");
  }
  if (typeof node.get("pattern") === "string") {
    if (typeof format !== "string")
      node.note(`matching the regular expression ${node.get("pattern")}`);
    node.remove("pattern");
  }
};

/**
 * Number bounds, folded into the description — including the ones sitting on a
 * node of the wrong type, since a keyword named `minimum` says nothing about
 * anything but a number and dropping it there loses nothing.
 *
 * **The safe-integer pair is dropped SILENTLY**, because it is not an author's
 * constraint: `z.number().int()` converts to
 * `{ type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 }`
 * (measured), and "greater than or equal to -9007199254740991" is noise in a
 * prompt. Mastra's layer has the same special case.
 */
const foldNumericConstraints: SchemaRule = (node) => {
  const minimum = node.get("minimum");
  if (typeof minimum === "number") {
    if (minimum !== Number.MIN_SAFE_INTEGER) node.note(`greater than or equal to ${minimum}`);
    node.remove("minimum");
  }
  const maximum = node.get("maximum");
  if (typeof maximum === "number") {
    if (maximum !== Number.MAX_SAFE_INTEGER) node.note(`less than or equal to ${maximum}`);
    node.remove("maximum");
  }
  // Draft-07 also allows a BOOLEAN here (the draft-4 spelling, a modifier on
  // `minimum`); the numeric guard leaves that form alone rather than reporting
  // `greater than true`. Our conversion emits only the numeric form.
  const exclusiveMinimum = node.get("exclusiveMinimum");
  if (typeof exclusiveMinimum === "number") {
    node.note(`greater than ${exclusiveMinimum}`);
    node.remove("exclusiveMinimum");
  }
  const exclusiveMaximum = node.get("exclusiveMaximum");
  if (typeof exclusiveMaximum === "number") {
    node.note(`less than ${exclusiveMaximum}`);
    node.remove("exclusiveMaximum");
  }
  const multipleOf = node.get("multipleOf");
  if (typeof multipleOf === "number") {
    node.note(`a multiple of ${multipleOf}`);
    node.remove("multipleOf");
  }
};

/**
 * Array length, folded into the description. Equal bounds are one sentence
 * rather than two — which is also what a tuple leaves behind once
 * {@link collapseTuple} has taken its `prefixItems`, so the ORDER of the two in
 * {@link GEMINI_SCHEMA_RULES} is what turns `z.tuple([a, b])` into
 * "exactly 2 items" instead of losing its arity entirely.
 */
const foldArrayConstraints: SchemaRule = (node) => {
  const minItems = node.get("minItems");
  const maxItems = node.get("maxItems");
  if (typeof minItems === "number" && minItems === maxItems) {
    node.note(`exactly ${minItems} items`);
    node.remove("minItems");
    node.remove("maxItems");
    return;
  }
  if (typeof minItems === "number") {
    node.note(`at least ${minItems} items`);
    node.remove("minItems");
  }
  if (typeof maxItems === "number") {
    node.note(`at most ${maxItems} items`);
    node.remove("maxItems");
  }
};

/**
 * `default` — emitted by `z.string().default("hi")` under the `"input"`
 * direction tool parameters are converted with — folded into the description.
 * The value is the whole point of the keyword: told what a field defaults to,
 * a model can leave it out on purpose.
 */
const foldDefault: SchemaRule = (node) => {
  if (!node.has("default")) return;
  node.note(`defaults to ${JSON.stringify(node.get("default"))}`);
  node.remove("default");
};

/**
 * `const` → a one-value `enum`, which is how the OpenAPI 3.0 subset spells the
 * same thing. `z.literal("x")` emits `{ type: "string", const: "x" }`.
 * A node already carrying an `enum` keeps it — the two would have to be
 * intersected, and a wrong intersection silently changes what the tool accepts.
 */
const constToEnum: SchemaRule = (node) => {
  if (!node.has("const")) return;
  if (!node.has("enum")) node.set("enum", [node.get("const")]);
  node.remove("const");
};

/**
 * `oneOf` → `anyOf`: Gemini accepts one and not the other. Exactly-one-of is
 * weakened to at-least-one-of, which is guidance a model reads the same way.
 * A node carrying both is left alone for {@link constToEnum}'s reason.
 */
const oneOfToAnyOf: SchemaRule = (node) => {
  const oneOf = node.get("oneOf");
  if (!Array.isArray(oneOf) || node.has("anyOf")) return;
  node.set("anyOf", oneOf);
  node.remove("oneOf");
};

/**
 * A `type` ARRAY, which OpenAPI 3.0 has no way to express — and the most common
 * of these rewrites, because it is how zod converts both of the two things an
 * author writes constantly: `z.string().nullable()` emits
 * `{ type: ["string", "null"] }` and `z.union([z.string(), z.number()])` emits
 * `{ type: ["string", "number"] }` (both measured).
 *
 * One surviving type becomes a plain `type`; several become an `anyOf` of
 * single-type branches. Nullability has no keyword left to live in — Mastra
 * writes OpenAPI's `nullable: true`, which this layer will not add — so it
 * becomes prose, which is at least what the description is for.
 */
const foldTypeUnion: SchemaRule = (node) => {
  const type = node.get("type");
  if (!Array.isArray(type) || node.has("anyOf")) return;
  if (!type.every((entry) => typeof entry === "string")) return;
  const named = type.filter((entry) => entry !== "null");
  // `["null"]` alone: nothing to keep, and the subset cannot say "null" — see
  // the module doc's known gaps.
  if (named.length === 0) return;
  if (named.length === 1) node.set("type", named[0]);
  else {
    node.set(
      "anyOf",
      named.map((entry) => ({ type: entry })),
    );
    node.remove("type");
  }
  if (named.length !== type.length) node.note("may be null");
};

/**
 * A tuple. `z.tuple([z.string(), z.number()])` converts to
 * `{ type: "array", prefixItems: [...], items: false, minItems: 2, maxItems: 2 }`
 * (measured) — three shapes the subset does not have, where `items` must be a
 * single schema. The per-position types collapse into one `items` union, the
 * arity having already become prose in {@link foldArrayConstraints}.
 *
 * A node that carries BOTH `prefixItems` and a real `items` schema (2020-12's
 * "and the rest look like this") keeps the rest-schema and loses the head: the
 * alternative is unioning them, which widens what each position accepts.
 */
const collapseTuple: SchemaRule = (node) => {
  const prefixItems = node.get("prefixItems");
  if (Array.isArray(prefixItems) && prefixItems.length > 0) {
    const rest = node.get("items");
    if (rest === undefined || rest === false) {
      node.set("items", prefixItems.length === 1 ? prefixItems[0] : { anyOf: prefixItems });
    }
    node.remove("prefixItems");
  }
  // `items: false` — "no further items" — is a boolean where a schema belongs.
  if (node.get("items") === false) node.remove("items");
};

/** Applied to every model the gateway serves. See the module doc. */
export const GATEWAY_SCHEMA_RULES: readonly SchemaRule[] = [dropGatewayUnsupported];

/**
 * Applied to Gemini only, because every rule past the first is lossy. Order
 * matters twice: {@link foldArrayConstraints} runs before {@link collapseTuple}
 * so a tuple's arity survives as prose, and {@link dropGatewayUnsupported}
 * leads so the two verified removals happen whatever follows them does.
 */
export const GEMINI_SCHEMA_RULES: readonly SchemaRule[] = [
  dropGatewayUnsupported,
  dropAdditionalProperties,
  foldStringConstraints,
  foldNumericConstraints,
  foldArrayConstraints,
  foldDefault,
  constToEnum,
  oneOfToAnyOf,
  foldTypeUnion,
  collapseTuple,
];

/**
 * Ids whose function-calling subset is Gemini's. Substring rather than an
 * enumeration of `ASSEMBLYAI_GATEWAY_MODELS`: the catalog is regenerated from
 * what the gateway advertises, and a new `gemini-*` id must not have to wait
 * for a second edit here.
 */
const GEMINI_MODEL_PATTERN = /gemini|google/i;

/** The rules for one model id — {@link GATEWAY_SCHEMA_RULES} unless it is Gemini's. */
export function toolSchemaRules(modelId: string | undefined): readonly SchemaRule[] {
  return modelId !== undefined && GEMINI_MODEL_PATTERN.test(modelId)
    ? GEMINI_SCHEMA_RULES
    : GATEWAY_SCHEMA_RULES;
}
