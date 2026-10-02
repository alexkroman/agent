// Copyright 2026 the AAI authors. MIT license.
/**
 * The LLM registry: each entry labelled from the SDK catalog, and the lookup
 * that lets an UNREGISTERED provider resolve as an OpenAI-compatible endpoint
 * when its descriptor names a `baseUrl`. Building a client makes no request.
 */

import { LLM_PROVIDERS } from "@alexkroman1/aai/host-internal";
import { describe, expect, it, test } from "vitest";
import { compatibleEnvVar, LLM_REGISTRY, llmEntryFor } from "./_llm-registry.ts";

describe("LLM_REGISTRY", () => {
  it("labels each LLM entry from the catalog, which is what a missing-key error prints", () => {
    for (const d of Object.values(LLM_PROVIDERS)) expect(LLM_REGISTRY[d.kind]?.label).toBe(d.label);
  });
});

describe("compatibleEnvVar", () => {
  test.each([
    ["together", "TOGETHER_API_KEY"],
    ["together-ai", "TOGETHER_AI_API_KEY"],
    ["my.vendor/v2", "MY_VENDOR_V2_API_KEY"],
  ])("%s reads %s", (provider, envVar) => {
    expect(compatibleEnvVar(provider)).toBe(envVar);
  });
});

describe("llmEntryFor", () => {
  test("a registered kind answers its registry entry by identity", () => {
    expect(llmEntryFor({ kind: "anthropic", options: { model: "m" } })).toBe(
      LLM_REGISTRY.anthropic,
    );
  });

  test("an unregistered kind with a baseUrl becomes an OpenAI-compatible entry", () => {
    const entry = llmEntryFor({
      kind: "my-vendor",
      options: { model: "m", baseUrl: "https://llm.example.test/v1" },
    });
    expect(entry).toMatchObject({
      envVar: "MY_VENDOR_API_KEY",
      label: "my-vendor (OpenAI-compatible)",
    });
    expect(entry?.create("fake-key", { kind: "my-vendor", options: { model: "m" } })).toMatchObject(
      { provider: "my-vendor.chat", modelId: "m" },
    );
  });

  test.each([
    ["no kind", { options: { baseUrl: "https://x.test" } }],
    ["a non-string kind", { kind: 7 }],
    ["an unregistered kind with no baseUrl", { kind: "my-vendor", options: { model: "m" } }],
    ["an empty baseUrl", { kind: "my-vendor", options: { baseUrl: "" } }],
    ["non-record options", { kind: "my-vendor", options: "https://x.test" }],
  ])("answers undefined for %s", (_label, descriptor) => {
    expect(llmEntryFor(descriptor)).toBeUndefined();
  });
});
