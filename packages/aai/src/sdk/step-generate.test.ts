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

import { describe, expect, test, vi } from "vitest";
import {
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
} from "./providers/llm/assemblyai.ts";
import { StepGenerateError, stepGenerate } from "./step-generate.ts";
import { stubGateway } from "./testing-gateway.ts";

/**
 * The SDK's own fake gateway, installed — see `sdk/testing-gateway.ts`, which
 * is published as `@alexkroman1/aai/testing` precisely so a spec for a step
 * that calls this module does not re-implement one. It decodes the request
 * body and lower-cases the headers, so the local `sent()` re-parse this file
 * used to carry is its job now. `step-generate-json.test.ts` uses it the same
 * way.
 */
function install(replies: string | readonly string[], status?: number) {
  const gateway = stubGateway(replies, status === undefined ? {} : { status });
  vi.stubGlobal("fetch", gateway.fetch);
  return gateway;
}

describe("stepGenerate", () => {
  test("asks the gateway and returns the trimmed reply", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const gateway = install("  Otters use tools.  ");

    expect(await stepGenerate("Tell me about otters")).toBe("Otters use tools.");
    expect(gateway.calls[0]?.url).toBe(`${ASSEMBLYAI_LLM_GATEWAY_URL}/chat/completions`);
  });

  test("sends the key as a BEARER, which is what this endpoint takes", async () => {
    // AssemblyAI's streaming sockets take the key raw; getting the two the wrong
    // way round is a 401 that reads like a wrong key.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const gateway = install("hi");
    await stepGenerate("hi");
    expect(gateway.calls[0]?.headers.authorization).toBe("Bearer sk-test");
  });

  test("defaults to the model an agent's own pipeline resolves", async () => {
    // So a workflow and the agent that owns it cannot silently run on different
    // models.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const gateway = install("hi");
    await stepGenerate("hi");
    expect(gateway.calls[0]?.body.model).toBe(ASSEMBLYAI_LLM_DEFAULT_MODEL);
  });

  test("turns reasoning off, the same as the shipped voice pipeline", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const gateway = install("hi");
    await stepGenerate("hi");
    expect(gateway.calls[0]?.body.reasoning_effort).toBe("none");
  });

  test("drops an unset system message rather than sending an empty one", async () => {
    // An empty system message is a message the model still reads.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const gateway = install("hi");
    await stepGenerate("hi");
    expect(gateway.calls[0]?.body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(gateway.calls[0]?.system).toBeUndefined();
  });

  test("sends the system message ahead of the prompt when there is one", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const gateway = install("hi");
    await stepGenerate("hi", { system: "Be brief." });
    expect(gateway.calls[0]?.body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
    ]);
  });

  test("omits an unset knob entirely rather than sending it undefined", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const gateway = install("hi");
    await stepGenerate("hi", { temperature: 0.2 });
    expect(gateway.calls[0]?.body).toMatchObject({ temperature: 0.2 });
    expect(gateway.calls[0]?.body).not.toHaveProperty("max_tokens");
  });

  test("honours an overridden gateway, model and key name", async () => {
    // The EU endpoint is the case this exists for; the key name is the one an
    // agent with a second account would need.
    vi.stubEnv("SECOND_KEY", "sk-eu");
    const gateway = install("hi");
    await stepGenerate("hi", {
      gatewayUrl: ASSEMBLYAI_LLM_GATEWAY_EU_URL,
      model: "gpt-5.6-luna",
      apiKeyEnv: "SECOND_KEY",
    });
    expect(gateway.calls[0]?.url).toBe(`${ASSEMBLYAI_LLM_GATEWAY_EU_URL}/chat/completions`);
    expect(gateway.calls[0]?.body.model).toBe("gpt-5.6-luna");
    expect(gateway.calls[0]?.headers.authorization).toBe("Bearer sk-eu");
  });
});

describe("what a failure tells the step to do", () => {
  test("a rate limit is RETRYABLE, which is what the DevKit's retries are for", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    install("", 429);
    await expect(stepGenerate("hi")).rejects.toMatchObject({
      name: "StepGenerateError",
      status: 429,
      retryable: true,
    });
  });

  // `test.each` rather than a `for…of`: the reporter names the status that
  // failed, where a loop reports the whole case as one anonymous failure.
  test.each([408, 500, 503])("a %i is retryable too", async (status) => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    install("", status);
    await expect(stepGenerate("hi")).rejects.toMatchObject({ retryable: true, status });
  });

  test.each([400, 401, 404])(
    "a %i is NOT, so the caller can stop rather than burn five attempts",
    async (status) => {
      vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
      install("", status);
      await expect(stepGenerate("hi")).rejects.toMatchObject({ retryable: false, status });
    },
  );

  test("quotes what the gateway said, so the failure is diagnosable", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    install("", 401);
    await expect(stepGenerate("hi")).rejects.toThrow(/HTTP 401 — .*stub gateway: HTTP 401/);
  });

  test("a 200 carrying no completion is a failure, and a retryable one", async () => {
    // A step returning `""` here would file a blank report and report success,
    // which is the worst shape this can take.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    install("   ");
    await expect(stepGenerate("hi")).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("empty completion"),
    });
  });

  test("a missing key fails by name, and never retryably", async () => {
    install("hi");
    const error = await stepGenerate("hi").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StepGenerateError);
    expect(error).toMatchObject({ retryable: false });
    expect(String(error)).toContain("ASSEMBLYAI_API_KEY");
  });

  test("a missing key does not reach the network at all", async () => {
    const gateway = install("hi");
    await expect(stepGenerate("hi")).rejects.toThrow();
    expect(gateway.calls).toHaveLength(0);
  });
});

describe("failures that used to escape the class", () => {
  /**
   * `stepFetch` catches everything the request throws — this call's own
   * `AbortSignal.timeout` included — and rethrows a `StepTransportError`. So
   * the two failure modes this module most advertises handling escaped as a
   * class the documented `catch` does not recognise:
   * `err instanceof StepGenerateError && !err.retryable` is what two templates
   * copy verbatim, and `toStepError` falls through to "no verdict available"
   * for anything else.
   */
  test("a request that never got an answer is a StepGenerateError, and retryable", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("socket hang up"))),
    );
    const error = await stepGenerate("hi").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StepGenerateError);
    expect(error).toMatchObject({ retryable: true });
  });

  test("this call's OWN deadline is one of them", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        // What the platform really raises when `AbortSignal.timeout` fires: a
        // `TimeoutError` out of `fetch`, which `stepFetch` wraps.
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
      }),
    );
    const error = await stepGenerate("hi", { timeoutMs: 5 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StepGenerateError);
    expect(error).toMatchObject({ retryable: true });
    // The transport error is kept as the cause, because its message carries the
    // whole code chain that says WHICH failure this was.
    expect(String((error as StepGenerateError).cause)).toContain("TimeoutError");
  });

  test("a 200 that is not JSON is a StepGenerateError quoting the body", async () => {
    // A proxy or a saturated gateway answers HTML with whatever status it
    // likes; `response.json()` rejected with a bare `SyntaxError` naming
    // neither the gateway nor the status.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response("<html>502 Bad Gateway</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      ),
    );
    const error = await stepGenerate("hi").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StepGenerateError);
    expect(error).toMatchObject({ retryable: true, status: 200 });
    expect(String(error)).toContain("<html>502 Bad Gateway</html>");
  });
});
