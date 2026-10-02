// Copyright 2026 the AAI authors. MIT license.
/** `installStubLlm`: the scripted model an eval falls back to when there is no key. */

import { describe, expect, test } from "vitest";
import { installStubLlm, STUB_LLM_API_KEY_ENV } from "./stub-llm.ts";

describe("installStubLlm", () => {
  test("registers a kind that resolves like a provider, with its own credential", () => {
    const stub = installStubLlm("hello");
    try {
      expect(stub.llm.kind).toContain("stub-llm");
      expect(stub.env[STUB_LLM_API_KEY_ENV]).toBeTypeOf("string");
    } finally {
      stub.release();
    }
  });

  test("each install gets its own kind, so two sessions cannot cross-talk", () => {
    const a = installStubLlm("a");
    const b = installStubLlm("b");
    try {
      expect(a.llm.kind).not.toBe(b.llm.kind);
    } finally {
      a.release();
      b.release();
    }
  });
});
