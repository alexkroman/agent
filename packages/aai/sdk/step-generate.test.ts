// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the step-side model call.
 *
 * Every one of these is a rule a template had already got wrong, or would have:
 * the bearer prefix (the gateway takes one, the streaming sockets do not), the
 * defaults coming from the same constants the agent's pipeline resolves, an
 * unset knob being ABSENT rather than `undefined`, and — the one that decides
 * whether a step retries or gives up — the `retryable` split.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
} from "./providers/llm/assemblyai.ts";
import { StepGenerateError, stepGenerate } from "./step-generate.ts";

const SLOT = Symbol.for("@alexkroman1/aai.stepEnv");

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
});

/** A gateway answering `content`, recording every request. */
function stubGateway(content: string, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : "denied",
        { status, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return calls;
}

/** What one recorded request actually sent. */
function sent(call: { url: string; init: RequestInit } | undefined) {
  return {
    headers: (call?.init.headers ?? {}) as Record<string, string>,
    body: JSON.parse(String(call?.init.body)) as Record<string, unknown>,
  };
}

describe("stepGenerate", () => {
  test("asks the gateway and returns the trimmed reply", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const calls = stubGateway("  Otters use tools.  ");

    expect(await stepGenerate("Tell me about otters")).toBe("Otters use tools.");
    expect(calls[0]?.url).toBe(`${ASSEMBLYAI_LLM_GATEWAY_URL}/chat/completions`);
  });

  test("sends the key as a BEARER, which is what this endpoint takes", async () => {
    // AssemblyAI's streaming sockets take the key raw; getting the two the wrong
    // way round is a 401 that reads like a wrong key.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const calls = stubGateway("hi");
    await stepGenerate("hi");
    expect(sent(calls[0]).headers.Authorization).toBe("Bearer sk-test");
  });

  test("defaults to the model an agent's own pipeline resolves", async () => {
    // So a workflow and the agent that owns it cannot silently run on different
    // models.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const calls = stubGateway("hi");
    await stepGenerate("hi");
    expect(sent(calls[0]).body.model).toBe(ASSEMBLYAI_LLM_DEFAULT_MODEL);
  });

  test("turns reasoning off, the same as the shipped voice pipeline", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const calls = stubGateway("hi");
    await stepGenerate("hi");
    expect(sent(calls[0]).body.reasoning_effort).toBe("none");
  });

  test("drops an unset system message rather than sending an empty one", async () => {
    // An empty system message is a message the model still reads.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const calls = stubGateway("hi");
    await stepGenerate("hi");
    expect(sent(calls[0]).body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("sends the system message ahead of the prompt when there is one", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const calls = stubGateway("hi");
    await stepGenerate("hi", { system: "Be brief." });
    expect(sent(calls[0]).body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
    ]);
  });

  test("omits an unset knob entirely rather than sending it undefined", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const calls = stubGateway("hi");
    await stepGenerate("hi", { temperature: 0.2 });
    const { body } = sent(calls[0]);
    expect(body.temperature).toBe(0.2);
    expect("max_tokens" in body).toBe(false);
  });

  test("honours an overridden gateway, model and key name", async () => {
    // The EU endpoint is the case this exists for; the key name is the one an
    // agent with a second account would need.
    vi.stubEnv("SECOND_KEY", "sk-eu");
    const calls = stubGateway("hi");
    await stepGenerate("hi", {
      gatewayUrl: ASSEMBLYAI_LLM_GATEWAY_EU_URL,
      model: "gpt-5.6-luna",
      apiKeyEnv: "SECOND_KEY",
    });
    expect(calls[0]?.url).toBe(`${ASSEMBLYAI_LLM_GATEWAY_EU_URL}/chat/completions`);
    expect(sent(calls[0]).body.model).toBe("gpt-5.6-luna");
    expect(sent(calls[0]).headers.Authorization).toBe("Bearer sk-eu");
  });
});

describe("what a failure tells the step to do", () => {
  test("a rate limit is RETRYABLE, which is what the DevKit's retries are for", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubGateway("", 429);
    await expect(stepGenerate("hi")).rejects.toMatchObject({
      name: "StepGenerateError",
      status: 429,
      retryable: true,
    });
  });

  test("a 5xx and a 408 are retryable too", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    for (const status of [408, 500, 503]) {
      stubGateway("", status);
      await expect(stepGenerate("hi")).rejects.toMatchObject({ retryable: true, status });
    }
  });

  test("a rejected request is NOT, so the caller can stop rather than burn five attempts", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    for (const status of [400, 401, 404]) {
      stubGateway("", status);
      await expect(stepGenerate("hi")).rejects.toMatchObject({ retryable: false, status });
    }
  });

  test("quotes what the gateway said, so the failure is diagnosable", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubGateway("", 401);
    await expect(stepGenerate("hi")).rejects.toThrow(/HTTP 401 — denied/);
  });

  test("a 200 carrying no completion is a failure, and a retryable one", async () => {
    // A step returning `""` here would file a blank report and report success,
    // which is the worst shape this can take.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubGateway("   ");
    await expect(stepGenerate("hi")).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("empty completion"),
    });
  });

  test("a missing key fails by name, and never retryably", async () => {
    stubGateway("hi");
    const error = await stepGenerate("hi").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StepGenerateError);
    expect(error).toMatchObject({ retryable: false });
    expect(String(error)).toContain("ASSEMBLYAI_API_KEY");
  });

  test("a missing key does not reach the network at all", async () => {
    const calls = stubGateway("hi");
    await expect(stepGenerate("hi")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
