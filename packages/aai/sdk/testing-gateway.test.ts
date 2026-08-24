// Copyright 2026 the AAI authors. MIT license.
/**
 * The fake needs its own spec for the reason every gate in this repo does: a
 * recorder that quietly stopped recording leaves every suite that USES it green
 * while it checks nothing — `expect(calls[0]?.prompt).toContain(…)` on an empty
 * array is an assertion about `undefined`, and `toMatchObject` on a missing key
 * is vacuous. So what is pinned here is that it records, and what it records.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { stubStepFetch } from "./_testing-step-fetch.ts";
import { stepFetch } from "./step-fetch.ts";
import { stepGenerate } from "./step-generate.ts";
import { stubGateway, stubGatewayRoute } from "./testing-gateway.ts";

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

describe("stubGatewayRoute", () => {
  test("answers the completion shape stepGenerate reads, through the STEP slot", async () => {
    // Driven through the real `stepGenerate` and the real published slot, which
    // is the seam the seven hand-rolled copies were routing on: a fake that
    // only agrees with itself about the envelope proves nothing.
    const model = stubGatewayRoute("Otters use tools.");
    const fetched = stubStepFetch((request) => model.route(request) ?? { status: 404 });
    try {
      expect(await stepGenerate("What do otters do?")).toBe("Otters use tools.");
    } finally {
      fetched.restore();
    }
  });

  test("DECLINES a non-gateway request, so a caller composes the other leg", async () => {
    const model = stubGatewayRoute("ignored");
    const fetched = stubStepFetch(
      (request) => model.route(request) ?? { body: "<p>hi</p>", headers: { "X-Leg": "page" } },
    );
    try {
      const page = await stepFetch("https://example.test/post");
      expect(page.headers.get("X-Leg")).toBe("page");
      // Declining also means not RECORDING it: `calls` is the gateway's log.
      expect(model.calls).toEqual([]);
    } finally {
      fetched.restore();
    }
  });

  test("matches on the PATH, so a custom gatewayUrl still routes", async () => {
    const model = stubGatewayRoute("from the EU");
    const fetched = stubStepFetch((request) => model.route(request) ?? { status: 404 });
    try {
      expect(await stepGenerate("hi", { gatewayUrl: "https://llm.example.test/v9" })).toBe(
        "from the EU",
      );
      expect(model.calls[0]?.url).toBe("https://llm.example.test/v9/chat/completions");
    } finally {
      fetched.restore();
    }
  });

  test("the LAST reply repeats, so a model call in a LOOP cannot run the script out", async () => {
    const model = stubGatewayRoute(["first", "second"]);
    const fetched = stubStepFetch((request) => model.route(request) ?? { status: 404 });
    try {
      expect(await stepGenerate("a")).toBe("first");
      expect(await stepGenerate("b")).toBe("second");
      expect(await stepGenerate("c")).toBe("second");
      expect(model.calls).toHaveLength(3);
    } finally {
      fetched.restore();
    }
  });

  test("records the DECODED prompt and system, which no hand-rolled version had", async () => {
    const model = stubGatewayRoute("ok");
    const fetched = stubStepFetch((request) => model.route(request) ?? { status: 404 });
    try {
      await stepGenerate("Summarize this brief.", { system: "Be terse." });
      const call = model.calls[0];
      // `String(request.body)` — what one eval asserted its prompts against —
      // is the whole serialized request, model and temperature included.
      expect(call?.prompt).toBe("Summarize this brief.");
      expect(call?.system).toBe("Be terse.");
      expect(call?.body.model).toBeTypeOf("string");
      expect(call?.headers.authorization).toBe("Bearer sk-test");
    } finally {
      fetched.restore();
    }
  });

  test("a call with no system message reports `undefined`, not an empty string", async () => {
    const model = stubGatewayRoute("ok");
    const fetched = stubStepFetch((request) => model.route(request) ?? { status: 404 });
    try {
      await stepGenerate("just a prompt");
      expect(model.calls[0]?.system).toBeUndefined();
    } finally {
      fetched.restore();
    }
  });

  test("a status answers the error body stepGenerate quotes back", async () => {
    const model = stubGatewayRoute("never read", { status: 503 });
    const fetched = stubStepFetch((request) => model.route(request) ?? { status: 404 });
    try {
      await expect(stepGenerate("hi")).rejects.toThrow(/503/);
    } finally {
      fetched.restore();
    }
  });
});
