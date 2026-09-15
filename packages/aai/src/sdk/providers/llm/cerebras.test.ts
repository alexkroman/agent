// Copyright 2026 the AAI authors. MIT license.
/**
 * What `cerebrasLlm` PROMISES, rather than what it returns.
 *
 * The factory is three tokens of code, so a spec that re-states its shape
 * claims nothing. What is worth pinning is the two properties the module doc
 * asserts and a reader relies on — the descriptor carries no secret and
 * survives serialization, and the caller's options object is COPIED rather than
 * captured — plus the two constants, each of which is a wire fact: the base URL
 * is where requests go, and the env name is the key an operator has to set.
 */

import { describe, expect, it } from "vitest";
import { CEREBRAS_API_KEY_ENV, CEREBRAS_BASE_URL, CEREBRAS_KIND, cerebrasLlm } from "./cerebras.ts";

describe("cerebrasLlm", () => {
  it("is SERIALIZABLE and carries no credential", () => {
    // The whole reason there is no factory-time key parameter: this descriptor
    // is baked into a deployed agent's config and crosses a wire. A key
    // reaching it would be a secret in a stored artifact.
    const descriptor = cerebrasLlm({ model: "qwen-3.8-27b" });
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    expect(JSON.stringify(descriptor)).not.toMatch(/csk-|api[-_]?key/i);
  });

  it("COPIES the caller's options rather than capturing them", () => {
    // `{ ...options }` is load-bearing: an author building options
    // conditionally and reusing the object would otherwise mutate a descriptor
    // that has already been handed to `agent()`.
    const options = { model: "qwen-3.8-27b" };
    const descriptor = cerebrasLlm(options);
    options.model = "gpt-oss-120b";
    expect((descriptor.options as { model: string }).model).toBe("qwen-3.8-27b");
  });

  it("names the kind the host registry dispatches on", () => {
    expect(cerebrasLlm({ model: "qwen-3.8-27b" }).kind).toBe(CEREBRAS_KIND);
  });

  it("pins the two wire facts", () => {
    // Both are read by the host resolver, so a typo here is a request sent
    // somewhere else or a key an operator sets under the wrong name — neither
    // of which fails until a live session.
    expect(CEREBRAS_BASE_URL).toBe("https://api.cerebras.ai/v1");
    expect(CEREBRAS_API_KEY_ENV).toBe("CEREBRAS_API_KEY");
  });

  it("does NOT default a model, unlike the AssemblyAI stage", () => {
    // Cerebras serves a handful of models and none of them is a sensible
    // default, so `model` is required — which is why the host arm that selects
    // this vendor has to refuse a missing id rather than fill one in.
    const bare = cerebrasLlm({} as { model: string });
    expect((bare.options as { model?: string }).model).toBeUndefined();
  });
});
