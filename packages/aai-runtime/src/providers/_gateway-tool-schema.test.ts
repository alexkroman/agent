// Copyright 2026 the AAI authors. MIT license.

import type { LanguageModelMiddleware } from "ai";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, test } from "vitest";
import { gatewayToolSchemaMiddleware } from "./_gateway-tool-schema.ts";

/** The one argument shape `transformParams` is called with, from the vendor type. */
type TransformArgs = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0];
type CallParams = TransformArgs["params"];

/**
 * The middleware reads `params` and the model's id and nothing else, but the
 * vendor's type requires a whole model. One typed seam rather than a laundered
 * cast per call — the root guide's rule about a concentration of identical
 * casts being a missing seam.
 */
function modelWith(modelId: string): TransformArgs["model"] {
  return { modelId } as TransformArgs["model"];
}

/** A model whose id selects no provider layer beyond the unconditional one. */
const OPENAI_MODEL = modelWith("gpt-5.2");

async function transform(
  params: CallParams,
  model: TransformArgs["model"] = OPENAI_MODEL,
): Promise<CallParams> {
  const { transformParams } = gatewayToolSchemaMiddleware();
  // A plain throw rather than `expect.fail`: this is a helper precondition, and
  // an assertion outside a test body is what `noMisplacedAssertion` bans. The
  // vendor type makes `transformParams` optional; the middleware always sets it.
  if (!transformParams) throw new Error("gatewayToolSchemaMiddleware defines no transformParams");
  return await transformParams({ type: "stream", params, model });
}

/** Call params carrying `tools` and nothing else that matters. */
function paramsWith(tools: NonNullable<CallParams["tools"]>): CallParams {
  return { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools };
}

function functionTool(inputSchema: JSONSchema7): NonNullable<CallParams["tools"]>[number] {
  return { type: "function", name: "read_file", inputSchema };
}

/** The one property of a tool the assertions below are about. */
function schemasOf(params: CallParams): unknown[] {
  return (params.tools ?? []).map((tool) => (tool.type === "function" ? tool.inputSchema : tool));
}

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

describe("gatewayToolSchemaMiddleware model selection", () => {
  /** A schema the unconditional layer leaves alone and the Gemini layer folds. */
  const constrained: JSONSchema7 = {
    type: "object",
    properties: { path: { type: "string", minLength: 2 } },
  };

  test("a Gemini model id selects the lossy layer", async () => {
    const out = await transform(
      paramsWith([functionTool(constrained)]),
      modelWith("gemini-3.5-flash-lite"),
    );
    expect(schemasOf(out)).toEqual([
      {
        type: "object",
        properties: { path: { type: "string", description: "constraints: minimum length 2" } },
      },
    ]);
  });

  test("a non-Gemini model id keeps every constraint it declares", async () => {
    // The whole reason the second layer is gated: OpenAI, Claude and Qwen all
    // accept these keywords, and folding one into prose is strictly worse there.
    const params = paramsWith([functionTool(constrained)]);
    expect(await transform(params)).toBe(params);
  });

  test("an id the runtime did not supply falls back to the unconditional layer", async () => {
    // The vendor's type promises `modelId: string`; this asserts what happens
    // when its runtime does not keep that promise, which is the safe half
    // rather than a crash inside a request.
    const params = paramsWith([functionTool(constrained)]);
    expect(await transform(params, {} as TransformArgs["model"])).toBe(params);
  });
});
