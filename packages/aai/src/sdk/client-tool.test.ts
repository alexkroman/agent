// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { agentToolsToSchemas } from "./_internal-types.ts";
import { clientTool, clientToolBrand } from "./client-tool.ts";
import { tool } from "./define.ts";
import { createToolContext } from "./testing.ts";

describe("clientTool", () => {
  const getLocation = clientTool({
    description: "the caller's location",
    inputSchema: z.object({ precise: z.boolean() }),
    timeoutMs: 20_000,
  });

  test("carries the brand the runtime reads, with its timeout", () => {
    expect(clientToolBrand(getLocation)).toEqual({ timeoutMs: 20_000 });
    expect(clientToolBrand(clientTool({ description: "d" }))).toEqual({ timeoutMs: undefined });
  });

  test("an ordinary tool carries none", () => {
    expect(clientToolBrand(tool({ description: "d", execute: () => 1 }))).toBeUndefined();
  });

  test("the brand survives a spread and a second copy of this module (Symbol.for)", () => {
    expect(clientToolBrand({ ...getLocation })).toEqual({ timeoutMs: 20_000 });
    expect(Reflect.get(getLocation, Symbol.for("aai.clientTool"))).toEqual({ timeoutMs: 20_000 });
  });

  test("its schema is an ordinary tool's", () => {
    const [schema] = agentToolsToSchemas({ get_location: getLocation });
    expect(schema).toMatchObject({ name: "get_location", description: "the caller's location" });
    expect(schema?.parameters).toMatchObject({ properties: { precise: { type: "boolean" } } });
  });

  test("run with no browser session, it fails naming why", () => {
    expect(() => getLocation.execute({ precise: true }, createToolContext())).toThrow(
      /clientTool.*browser/,
    );
  });
});
