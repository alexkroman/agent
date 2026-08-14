// Copyright 2026 the AAI authors. MIT license.
/**
 * The fake needs its own spec for the reason every gate in this repo does: a
 * recorder that quietly stopped recording leaves every suite that USES it green
 * while it checks nothing — `expect(calls[0]?.prompt).toContain(…)` on an empty
 * array is an assertion about `undefined`, and `toMatchObject` on a missing key
 * is vacuous. So what is pinned here is that it records, and what it records.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { stepGenerate } from "./step-generate.ts";
import { stubGateway } from "./testing-gateway.ts";

beforeEach(() => {
  vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
});

describe("stubGateway", () => {
  test("answers the completion shape stepGenerate actually reads", async () => {
    // Driven through the real `stepGenerate` rather than asserted on the raw
    // Response: a fake whose envelope drifted from the reader would be a fake
    // that fails only in the suites that depend on it.
    const gateway = stubGateway("the reply");
    vi.stubGlobal("fetch", gateway.fetch);

    expect(await stepGenerate("ask")).toBe("the reply");
  });

  test("records the prompt, the system instruction and the headers", async () => {
    const gateway = stubGateway("ok");
    vi.stubGlobal("fetch", gateway.fetch);

    await stepGenerate("the question", { system: "be brief" });

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({
      prompt: "the question",
      system: "be brief",
      headers: { authorization: "Bearer sk-test" },
    });
    expect(gateway.calls[0]?.url).toContain("/chat/completions");
    expect(gateway.calls[0]?.body).toMatchObject({ reasoning_effort: "none" });
  });

  test("reports no system instruction as undefined rather than empty string", async () => {
    // `stepGenerate` DROPS an unset system message rather than sending it
    // blank, and a spec asserting that needs the two cases distinguishable.
    const gateway = stubGateway("ok");
    vi.stubGlobal("fetch", gateway.fetch);

    await stepGenerate("just the prompt");

    expect(gateway.calls[0]?.system).toBeUndefined();
  });

  test("answers a QUEUE in order, then repeats the last", async () => {
    // What a step whose model call sits in a LOOP needs: a stub that says the
    // same thing every turn can only drive such a loop into its budget, and one
    // that runs out mid-loop fails on the stub rather than on the code.
    const gateway = stubGateway(["first", "second"]);
    vi.stubGlobal("fetch", gateway.fetch);

    expect(await stepGenerate("a")).toBe("first");
    expect(await stepGenerate("b")).toBe("second");
    expect(await stepGenerate("c")).toBe("second");
    expect(gateway.calls.map((call) => call.prompt)).toEqual(["a", "b", "c"]);
  });

  test("fails the call with the status it was given", async () => {
    const gateway = stubGateway("", { status: 401 });
    vi.stubGlobal("fetch", gateway.fetch);

    await expect(stepGenerate("ask")).rejects.toThrow(/HTTP 401/);
  });

  test("carries extra headers, so a retry-delay spec has something to read", async () => {
    const gateway = stubGateway("", { status: 429, headers: { "Retry-After": "30" } });
    vi.stubGlobal("fetch", gateway.fetch);

    const err = await stepGenerate("ask").catch((thrown: unknown) => thrown);
    expect((err as { retryAfter?: Date }).retryAfter?.getTime()).toBeGreaterThan(
      Date.now() + 25_000,
    );
  });
});
