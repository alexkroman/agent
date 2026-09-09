// Copyright 2026 the AAI authors. MIT license.
/**
 * Which variable a descriptor's credential lives in.
 *
 * Three functions, one question, and the failure they exist to prevent is
 * SILENT: a preflight that names `ASSEMBLYAI_API_KEY` while the session
 * resolves `ASSEMBLYAI_STAGING_KEY` reports the wrong key as missing and never
 * reports the right one. So every case here is about the override winning, or
 * about what happens when it is absent.
 */

import { anthropicLlm, assemblyAILlm } from "@alexkroman1/aai/llm";
import { describe, expect, test } from "vitest";
import { descriptorEnvVar, envVarOf, llmProviderEnvVar } from "./_provider-env-var.ts";

describe("descriptorEnvVar", () => {
  test("reads a descriptor's own apiKeyEnv", () => {
    expect(descriptorEnvVar(anthropicLlm({ model: "m", apiKeyEnv: "MY_KEY" }))).toBe("MY_KEY");
  });

  test("answers undefined for a descriptor that named none", () => {
    expect(descriptorEnvVar(anthropicLlm({ model: "m" }))).toBeUndefined();
    expect(descriptorEnvVar(undefined)).toBeUndefined();
  });

  test("a non-string or empty override falls through rather than resolving to nothing", () => {
    // The value is author-supplied and reaches here off a serialized config,
    // so `""` and a number are both reachable — and both would otherwise make
    // the key be read from a variable that cannot exist.
    expect(descriptorEnvVar({ options: { apiKeyEnv: "" } })).toBeUndefined();
    expect(descriptorEnvVar({ options: { apiKeyEnv: 7 } })).toBeUndefined();
  });
});

describe("envVarOf", () => {
  test("prefers the descriptor's override over the registry default", () => {
    const entry = { envVar: "REGISTRY_DEFAULT" };
    expect(envVarOf(entry, anthropicLlm({ model: "m", apiKeyEnv: "MY_KEY" }))).toBe("MY_KEY");
    expect(envVarOf(entry, anthropicLlm({ model: "m" }))).toBe("REGISTRY_DEFAULT");
  });
});

describe("llmProviderEnvVar", () => {
  test("answers the registry's variable for a known kind", () => {
    expect(llmProviderEnvVar(assemblyAILlm())).toBe("ASSEMBLYAI_API_KEY");
    expect(llmProviderEnvVar(anthropicLlm({ model: "m" }))).toBe("ANTHROPIC_API_KEY");
  });

  test("honours the descriptor's override, like every other credential read", () => {
    expect(llmProviderEnvVar(anthropicLlm({ model: "m", apiKeyEnv: "MY_KEY" }))).toBe("MY_KEY");
  });

  test("an UNKNOWN kind answers what the descriptor named, or nothing", () => {
    // A preflight does not throw on an unrecognized kind — naming the wrong
    // vendor's key is worse than naming none, so the honest answer for a kind
    // with no registry entry and no override is the empty string its caller
    // reads as "no credential to ask for".
    expect(llmProviderEnvVar({ kind: "not-a-vendor", options: { apiKeyEnv: "X_KEY" } })).toBe(
      "X_KEY",
    );
    expect(llmProviderEnvVar({ kind: "not-a-vendor", options: {} })).toBe("");
  });
});
