// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for `mergeRequestBody`, and for the regression it closes: an
 * OpenAI-compatible descriptor's `providerOptions` used to travel as the AI
 * SDK's `providerOptions.openai`, whose schema strips unknown keys, so a
 * vendor field such as OpenRouter's `provider: { order }` never reached the
 * wire. No real network — every request lands in a stub `fetch`.
 */

import { llm } from "@alexkroman1/aai/llm";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FetchLike, mergeRequestBody } from "./_request-body-extras.ts";
import { resolveLlm } from "./resolve.ts";

/** A non-streaming chat-completions reply the AI SDK parses cleanly. */
function completion(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A stub fetch recording each request body it receives, parsed. */
function recordingFetch(): { fetch: FetchLike; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return completion();
  };
  return { fetch, bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mergeRequestBody", () => {
  it("adds an extra the body does not carry", async () => {
    const { fetch, bodies } = recordingFetch();
    await mergeRequestBody({ top_k: 5 }, fetch)("https://x/v1", {
      method: "POST",
      body: JSON.stringify({ model: "m" }),
    });
    expect(bodies).toEqual([{ top_k: 5, model: "m" }]);
  });

  it("lets the SDK-built body win a collision", async () => {
    const { fetch, bodies } = recordingFetch();
    await mergeRequestBody({ model: "evil", stream: true, temperature: 1 }, fetch)("https://x", {
      method: "POST",
      body: JSON.stringify({ model: "m", stream: false }),
    });
    expect(bodies).toEqual([{ model: "m", stream: false, temperature: 1 }]);
  });

  it("passes a body that is not a JSON object through untouched", async () => {
    const seen: unknown[] = [];
    const inner: FetchLike = async (_input, init) => {
      seen.push(init?.body);
      return completion();
    };
    const wrapped = mergeRequestBody({ top_k: 5 }, inner);
    await wrapped("https://x", { body: "[1]" });
    await wrapped("https://x", { body: "not json" });
    await wrapped("https://x");
    expect(seen).toEqual(["[1]", "not json", undefined]);
  });
});

describe("an OpenAI-compatible descriptor's providerOptions reach the request body", () => {
  const cases = [
    ["openrouter", llm({ provider: "openrouter", model: "a/b" }), "OPENROUTER_API_KEY"],
    ["cerebras", llm({ provider: "cerebras", model: "m" }), "CEREBRAS_API_KEY"],
    [
      "an unregistered baseUrl provider",
      llm({ provider: "my-host", model: "m", baseUrl: "https://inference.example.com/v1" }),
      "MY_HOST_API_KEY",
    ],
  ] as const;

  it.each(cases)("%s", async (_name, base, envVar) => {
    const { fetch, bodies } = recordingFetch();
    vi.stubGlobal("fetch", fetch);
    const descriptor = {
      ...base,
      options: {
        ...base.options,
        providerOptions: { provider: { order: ["groq"] }, top_k: 5, model: "not-this" },
      },
    };
    const model = resolveLlm(descriptor, { [envVar]: "k" });
    await generateText({ model, prompt: "hi", temperature: 0.2 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      provider: { order: ["groq"] },
      top_k: 5,
      temperature: 0.2,
      model: base.options.model,
    });
  });
});
