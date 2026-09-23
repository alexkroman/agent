// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { openAICompatibleLlm } from "./experimental.ts";

describe("openAICompatibleLlm", () => {
  test("is the llm() descriptor the runtime's baseUrl fallback resolves", () => {
    const d = openAICompatibleLlm({
      provider: "my-host",
      model: "m",
      baseUrl: "https://llm.example.test/v1",
      apiKeyEnv: "MY_KEY",
    });
    expect(d).toEqual({
      kind: "my-host",
      options: { model: "m", baseUrl: "https://llm.example.test/v1", apiKeyEnv: "MY_KEY" },
    });
  });

  test("carries providerOptions only when given", () => {
    const d = openAICompatibleLlm({
      provider: "my-host",
      model: "m",
      baseUrl: "https://llm.example.test/v1",
      apiKeyEnv: "MY_KEY",
      providerOptions: { temperature: 0 },
    });
    expect(d.options.providerOptions).toEqual({ temperature: 0 });
  });
});
