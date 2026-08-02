// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { stripUnsupportedToolSchemaKeywords } from "./_gateway-tool-schema.ts";

const body = (tools: unknown) =>
  JSON.stringify({ model: "gemini-2.5-flash", stream: true, messages: [], tools });

describe("stripUnsupportedToolSchemaKeywords", () => {
  test("removes $schema from a tool's parameters", () => {
    const out = JSON.parse(
      stripUnsupportedToolSchemaKeywords(
        body([
          {
            type: "function",
            function: {
              name: "read_file",
              parameters: {
                $schema: "http://json-schema.org/draft-07/schema#",
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          },
        ]),
      ),
    );
    const params = out.tools[0].function.parameters;
    expect(params.$schema).toBeUndefined();
    // Everything the model actually needs survives.
    expect(params).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  test("removes propertyNames from a nested property", () => {
    // How `z.record(z.string(), …)` serializes — nested, not at the root, so
    // a root-only strip would miss it.
    const out = JSON.parse(
      stripUnsupportedToolSchemaKeywords(
        body([
          {
            type: "function",
            function: {
              name: "test_agent",
              parameters: {
                type: "object",
                properties: {
                  args: { type: "object", propertyNames: { type: "string" } },
                },
              },
            },
          },
        ]),
      ),
    );
    expect(out.tools[0].function.parameters.properties.args).toEqual({ type: "object" });
  });

  test("leaves a request without tools byte-identical", () => {
    // This sits under every request the provider makes, including the ones in
    // a long agent loop that carry the whole conversation.
    const plain = JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(stripUnsupportedToolSchemaKeywords(plain)).toBe(plain);
  });

  test("passes through a non-JSON body unchanged", () => {
    expect(stripUnsupportedToolSchemaKeywords('not json but mentions "tools"')).toBe(
      'not json but mentions "tools"',
    );
  });

  test("keeps additionalProperties, which the gateway accepts", () => {
    // Bisected explicitly: removing `additionalProperties` did NOT fix the
    // 500, so it stays — stripping more than necessary would quietly widen
    // what a tool accepts.
    const out = JSON.parse(
      stripUnsupportedToolSchemaKeywords(
        body([
          {
            type: "function",
            function: {
              name: "t",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          },
        ]),
      ),
    );
    expect(out.tools[0].function.parameters.additionalProperties).toBe(false);
  });
});
