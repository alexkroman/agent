// Copyright 2026 the AAI authors. MIT license.
/**
 * Asking a schema what it accepts, without reaching through `~standard`.
 *
 * A tool's `inputSchema` and a workflow's `input` are both Standard Schemas, and
 * a spec that checks what one accepts is checking the ONE thing between a
 * hallucinated argument and an index into `undefined`. Doing it by hand is three
 * steps every time — optional-chain the schema, narrow on `.issues`, cast
 * `.value` — and eighteen sites across ten shipped templates had written them
 * out, the worst at twelve lines and carrying its file's only cast:
 *
 * ```ts no-check
 * const schema = toolOf(agentDef, "add_pizza").inputSchema;
 * if (!schema) throw new Error("add_pizza has no input schema");
 * const validate = (value: unknown) => schema["~standard"].validate(value);
 * const ok = await validate({ size: "small" });
 * if (ok.issues) throw new Error("expected valid input");
 * expect((ok.value as { quantity: number }).quantity).toBe(1);
 * ```
 *
 * The vendor interface is a wire contract, not an authoring surface: a spec
 * naming `~standard` is naming the seam the SDK exists to hide, and the
 * `.validate` call may be SYNCHRONOUS or async depending on the vendor — which
 * is the detail a hand-rolled version gets wrong first (a missing `await` makes
 * `.issues` `undefined` on a promise, and the negative test then passes for the
 * wrong reason).
 *
 * Two functions rather than one, because the positive and the negative case
 * want different answers: {@link parseSchemaInput} throws the issues and hands
 * back the parsed value, {@link schemaInputIssues} hands back the issues and
 * says nothing about the value.
 *
 * @module _testing-schema
 */

import {
  formatSchemaIssues,
  type StandardSchemaIssue,
  type StandardSchemaV1,
} from "./standard-schema.ts";
import { type ToolBearingAgent, toolOf } from "./testing-tools.ts";

/**
 * Validate `value` against `schema`, or throw naming every issue.
 *
 * @typeParam T - What the schema produces. Defaults to
 *   `Record<string, unknown>`, which is what a tool input schema is declared as.
 *
 * @param schema - A Standard Schema, or `undefined` — the shape
 *   `tool.inputSchema` and `workflow.input` both have. `undefined` is an ERROR
 *   rather than a pass, because "this declares no schema" is a different fact
 *   from "the schema accepted it" and a spec asserting the second must not be
 *   satisfied by the first.
 * @param what - How the schema is named in a failure. Defaults to
 *   `"the schema"`; pass the tool or workflow name where one is at hand.
 *
 * @throws When the schema refuses `value`, with the issues rendered as one line
 *   (`quantity: too small; size: invalid enum value`) — which is what makes the
 *   failure readable at all, since a raw issue array prints as `[Object]`.
 *
 * @example
 * ```ts no-check
 * import { parseSchemaInput } from "@alexkroman1/aai/testing";
 *
 * const parsed = await parseSchemaInput<{ voice: string }>(myWorkflow.input, {
 *   recording: "upl_1",
 *   voice: "jane",
 * });
 * expect(parsed.voice).toBe("jane");
 * ```
 *
 * @public
 */
export async function parseSchemaInput<T = Record<string, unknown>>(
  schema: StandardSchemaV1 | undefined,
  value: unknown,
  what = "the schema",
): Promise<T> {
  const result = await requireSchema(schema, what)["~standard"].validate(value);
  if (result.issues) {
    throw new Error(`${what} refused that input: ${formatSchemaIssues(result.issues)}`);
  }
  return result.value as T;
}

/**
 * The issues `schema` found in `value`, or `undefined` when it accepted it.
 *
 * The negative half of {@link parseSchemaInput}, and `undefined`-on-success is
 * deliberate: `expect(await schemaInputIssues(…)).toBeUndefined()` is the
 * accepting case and `…toBeDefined()` the refusing one, which is the pair every
 * hand-rolled site was already writing against `.issues`.
 *
 * @param schema - As {@link parseSchemaInput}: `undefined` throws rather than
 *   reporting "no issues", which would make a negative test pass for a schema
 *   that does not exist.
 * @param what - How the schema is named in that error.
 *
 * @example
 * ```ts no-check
 * import { schemaInputIssues } from "@alexkroman1/aai/testing";
 *
 * expect(await schemaInputIssues(myWorkflow.input, { voice: "not-a-voice" })).toBeDefined();
 * ```
 *
 * @public
 */
export async function schemaInputIssues(
  schema: StandardSchemaV1 | undefined,
  value: unknown,
  what = "the schema",
): Promise<readonly StandardSchemaIssue[] | undefined> {
  const result = await requireSchema(schema, what)["~standard"].validate(value);
  return result.issues;
}

/**
 * Validate `value` against the input schema of the tool `name`.
 *
 * {@link parseSchemaInput} with the lookup done — including `toolOf`'s "no such
 * tool" sentence, which names the tools that DO exist, since a lookup that
 * misses is nearly always a rename.
 *
 * @typeParam T - What the schema produces.
 *
 * @throws When the agent declares no tool called `name` (see `toolOf`), when
 *   that tool declares no `inputSchema`, or when the schema refuses `value`.
 *
 * @example
 * ```ts
 * import agentDef from "virtual:aai/agent";
 * import { parseToolInput } from "@alexkroman1/aai/testing";
 * import { expect } from "vitest";
 *
 * const parsed = await parseToolInput<{ quantity: number }>(agentDef, "add_pizza", {
 *   size: "small",
 *   crust: "thin",
 *   toppings: [],
 * });
 * // The schema's own default, which is the thing worth asserting here.
 * expect(parsed.quantity).toBe(1);
 * ```
 *
 * @public
 */
export async function parseToolInput<T = Record<string, unknown>>(
  agent: ToolBearingAgent,
  name: string,
  value: unknown,
): Promise<T> {
  return await parseSchemaInput<T>(toolOf(agent, name).inputSchema, value, `Tool ${name}`);
}

/**
 * The issues the tool `name`'s input schema found in `value`, or `undefined`.
 *
 * The negative half of {@link parseToolInput} — the assertion behind "a mood
 * outside the enum is refused by the schema", which is the one thing standing
 * between an LLM's untyped tool call and the tool body.
 *
 * @throws When the agent declares no such tool, or when it declares no
 *   `inputSchema`. A tool that takes no arguments accepts anything, and saying
 *   so out loud beats answering `undefined` — which reads as "accepted".
 *
 * @example
 * ```ts no-check
 * import { toolInputIssues } from "@alexkroman1/aai/testing";
 *
 * expect(await toolInputIssues(agentDef, "recommend", { mood: "melancholy" })).toBeDefined();
 * ```
 *
 * @public
 */
export async function toolInputIssues(
  agent: ToolBearingAgent,
  name: string,
  value: unknown,
): Promise<readonly StandardSchemaIssue[] | undefined> {
  return await schemaInputIssues(toolOf(agent, name).inputSchema, value, `Tool ${name}`);
}

/**
 * The schema, or the error that says there is none.
 *
 * A crash on `undefined["~standard"]` names the property rather than the
 * problem, and the problem is one of two authoring mistakes worth telling
 * apart in the message: the declaration is missing, or the spec is asking the
 * wrong object for one.
 */
function requireSchema(schema: StandardSchemaV1 | undefined, what: string): StandardSchemaV1 {
  if (!schema) {
    throw new Error(
      `${what} declares no input schema, so there is nothing to validate. ` +
        "A tool with no `inputSchema` accepts any arguments the model sends; " +
        "add one if that is what the test is about.",
    );
  }
  return schema;
}
