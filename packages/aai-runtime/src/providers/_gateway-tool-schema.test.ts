// Copyright 2026 the AAI authors. MIT license.

import type { LanguageModelMiddleware } from "ai";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, test } from "vitest";
import { gatewayToolSchemaMiddleware, pruneToolSchema } from "./_gateway-tool-schema.ts";

/** The one argument shape `transformParams` is called with, from the vendor type. */
type TransformArgs = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0];
type CallParams = TransformArgs["params"];

/**
 * The middleware reads `params` and nothing else, but the vendor's type requires
 * a model. One typed seam rather than a laundered cast per call — the root
 * guide's rule about a concentration of identical casts being a missing seam.
 */
const UNUSED_MODEL = {} as TransformArgs["model"];

async function transform(params: CallParams): Promise<CallParams> {
  const { transformParams } = gatewayToolSchemaMiddleware();
  // A plain throw rather than `expect.fail`: this is a helper precondition, and
  // an assertion outside a test body is what `noMisplacedAssertion` bans. The
  // vendor type makes `transformParams` optional; the middleware always sets it.
  if (!transformParams) throw new Error("gatewayToolSchemaMiddleware defines no transformParams");
  return await transformParams({ type: "stream", params, model: UNUSED_MODEL });
}

/** Call params carrying `tools` and nothing else that matters. */
function paramsWith(tools: NonNullable<CallParams["tools"]>): CallParams {
  return { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools };
}

function functionTool(inputSchema: JSONSchema7): NonNullable<CallParams["tools"]>[number] {
  return { type: "function", name: "read_file", inputSchema };
}

describe("pruneToolSchema", () => {
  test("removes $schema from the root of a tool schema", () => {
    // Emitted by the AI SDK's zod conversion on every derived tool schema, and
    // the keyword that made 9 of the studio's 10 tools 500 on the Gemini path.
    const out = pruneToolSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    expect(out.$schema).toBeUndefined();
    // Everything the model actually needs survives.
    expect(out).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  test("removes propertyNames from a nested property", () => {
    // How `z.record(z.string(), …)` serializes — nested, not at the root, so a
    // root-only strip would miss it.
    const out = pruneToolSchema({
      type: "object",
      properties: { args: { type: "object", propertyNames: { type: "string" } } },
    });
    expect(out.properties?.args).toEqual({ type: "object" });
  });

  test("prunes inside an array-valued keyword", () => {
    // `anyOf`/`oneOf` branches are an array of schemas, so the walk has to
    // descend through arrays as well as objects.
    const out = pruneToolSchema({
      type: "object",
      properties: {
        mode: {
          anyOf: [{ type: "string" }, { type: "object", propertyNames: { type: "string" } }],
        },
      },
    });
    expect(out.properties?.mode).toEqual({ anyOf: [{ type: "string" }, { type: "object" }] });
  });

  test("keeps additionalProperties, which the gateway accepts", () => {
    // Bisected explicitly: removing `additionalProperties` did NOT fix the 500,
    // so it stays — stripping more than necessary would quietly widen what a
    // tool accepts.
    const out = pruneToolSchema({ type: "object", properties: {}, additionalProperties: false });
    expect(out.additionalProperties).toBe(false);
  });

  test("returns a clean schema by IDENTITY", () => {
    // The prune runs on every request of every model, so the common case — a
    // schema with nothing to remove — must allocate nothing.
    const clean: JSONSchema7 = { type: "object", properties: { path: { type: "string" } } };
    expect(pruneToolSchema(clean)).toBe(clean);
  });
});

describe("gatewayToolSchemaMiddleware", () => {
  test("prunes every function tool's input schema", async () => {
    const out = await transform(
      paramsWith([
        functionTool({ $schema: "https://json-schema.org/draft-07/schema#", type: "object" }),
        functionTool({ type: "object", propertyNames: { type: "string" } }),
      ]),
    );
    expect(out.tools).toEqual([
      { type: "function", name: "read_file", inputSchema: { type: "object" } },
      { type: "function", name: "read_file", inputSchema: { type: "object" } },
    ]);
  });

  test("leaves a provider-defined tool untouched", async () => {
    // A provider tool carries vendor arguments rather than a converted zod
    // schema, so it is neither a source of these keywords nor safe to walk.
    const providerTool = {
      type: "provider" as const,
      id: "openai.web_search" as const,
      name: "web_search",
      args: { propertyNames: "not a schema" },
    };
    const out = await transform(paramsWith([providerTool]));
    expect(out.tools?.[0]).toBe(providerTool);
  });

  test("returns the params object by IDENTITY when no schema needs pruning", async () => {
    // This sits under every request the provider makes, including the ones in a
    // long agent loop that carry the whole conversation. Nothing about a clean
    // request may be rebuilt.
    const params = paramsWith([functionTool({ type: "object" })]);
    expect(await transform(params)).toBe(params);
  });

  test("returns the params object by IDENTITY when there are no tools", async () => {
    const params: CallParams = {
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    };
    expect(await transform(params)).toBe(params);
  });

  test("returns the params object by IDENTITY for an empty tool list", async () => {
    const params = paramsWith([]);
    expect(await transform(params)).toBe(params);
  });
});
