// Copyright 2026 the AAI authors. MIT license.
/**
 * The hosts a live eval's model reaches — the one passthrough an eval network
 * allows unasked. Read off the descriptors, so each case below is a descriptor
 * shape an agent really declares.
 */

import { llm } from "@alexkroman1/aai/llm";
import { describe, expect, test } from "vitest";
import { modelHosts } from "./_model-hosts.ts";

describe("modelHosts", () => {
  test("the default stage is the AssemblyAI gateway, both regions", () => {
    expect(modelHosts([undefined])).toEqual([
      "llm-gateway.assemblyai.com",
      "llm-gateway.eu.assemblyai.com",
    ]);
  });

  test("a named provider is its own API host; a baseUrl wins; duplicates fold", () => {
    expect(
      modelHosts([
        llm({ provider: "anthropic", model: "claude-haiku-4-5" }),
        llm({ provider: "anthropic", model: "claude-sonnet-4-5" }),
        llm({ provider: "openai", model: "gpt-5", baseUrl: "https://llm.proxy.example/v1" }),
      ]),
    ).toEqual(["api.anthropic.com", "llm.proxy.example"]);
  });

  test("a kind it does not know — a scripted test model — makes no request, so passes nothing", () => {
    expect(modelHosts([{ kind: "eval-spec-llm", options: { model: "stub" } }])).toEqual([]);
  });
});
