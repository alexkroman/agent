// Copyright 2026 the AAI authors. MIT license.
/**
 * The descriptor → `LanguageModel` memo: keyed on the descriptor OBJECT, so the
 * same declaration reuses one client and an equal-but-distinct one does not.
 * Building a client makes no request, so the real resolver runs.
 */

import type { LlmProvider } from "@alexkroman1/aai/llm";
import { describe, expect, test } from "vitest";
import { createLlmModelCache, isLlmDescriptor } from "./_llm-model-cache.ts";

const ENV = { ANTHROPIC_API_KEY: "fake-key" };

describe("isLlmDescriptor", () => {
  test.each([
    [{ kind: "anthropic", options: { model: "m" } }, true],
    [{ kind: "anthropic" }, true],
    [{ kind: 7 }, false],
    [{}, false],
    [undefined, false],
    [null, false],
    ["anthropic", false],
  ])("%j → %s", (value, expected) => {
    expect(isLlmDescriptor(value)).toBe(expected);
  });
});

describe("createLlmModelCache", () => {
  test("resolves a descriptor to its vendor's model", () => {
    const resolve = createLlmModelCache(ENV);
    expect(resolve({ kind: "anthropic", options: { model: "claude-haiku-4-5" } })).toMatchObject({
      provider: "anthropic.messages",
      modelId: "claude-haiku-4-5",
    });
  });

  test("the same descriptor object answers the same model; an equal copy builds another", () => {
    const resolve = createLlmModelCache(ENV);
    const descriptor: LlmProvider = { kind: "anthropic", options: { model: "claude-haiku-4-5" } };
    const first = resolve(descriptor);
    expect(resolve(descriptor)).toBe(first);
    expect(resolve({ ...descriptor })).not.toBe(first);
  });

  test("two caches share nothing", () => {
    const descriptor: LlmProvider = { kind: "anthropic", options: { model: "claude-haiku-4-5" } };
    expect(createLlmModelCache(ENV)(descriptor)).not.toBe(createLlmModelCache(ENV)(descriptor));
  });

  test("a missing key throws from the resolver, and nothing is cached", () => {
    const resolve = createLlmModelCache({});
    const descriptor: LlmProvider = { kind: "anthropic", options: { model: "m" } };
    expect(() => resolve(descriptor)).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => resolve(descriptor)).toThrow(/ANTHROPIC_API_KEY/);
  });
});
