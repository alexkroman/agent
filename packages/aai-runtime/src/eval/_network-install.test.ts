// Copyright 2026 the AAI authors. MIT license.
/**
 * The suite dispatcher, without a suite around it.
 *
 * What `describeEval` relies on and could not observe from a case body: that
 * the live model's hosts bypass the network (and only in LIVE mode), that a
 * request between cases is refused into the last case's log rather than let
 * out, and that the global is put back.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { stepFetchOver, suiteNetwork, wantsNetwork } from "./_network-install.ts";
import { evalNetwork } from "./network.ts";

describe("suiteNetwork", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("swaps the global for the suite and puts the SAME one back", () => {
    const suite = suiteNetwork("stub", []);
    suite.install();
    expect(globalThis.fetch).not.toBe(original);
    suite.restore();
    expect(globalThis.fetch).toBe(original);
  });

  test("LIVE: the model's host goes to the replaced fetch and stays out of the log", async () => {
    const real = vi.fn<typeof fetch>(async () => new Response("model"));
    globalThis.fetch = real;
    const suite = suiteNetwork("live", [undefined]);
    suite.install();
    try {
      const { network } = suite.begin(evalNetwork());
      await globalThis.fetch("https://llm-gateway.assemblyai.com/v1/chat/completions");
      expect(real).toHaveBeenCalledTimes(1);
      expect(network.requests()).toEqual([]);
      // Anything else is the network's, and refused.
      await expect(globalThis.fetch("https://api.twilio.com/Calls")).rejects.toThrow(/refused/);
      expect(network.refused()).toHaveLength(1);
    } finally {
      suite.end();
      suite.restore();
    }
  });

  test("SCRIPTED: a provider host is a tool's request like any other, and is refused", async () => {
    const real = vi.fn<typeof fetch>(async () => new Response("model"));
    globalThis.fetch = real;
    const suite = suiteNetwork("stub", [undefined]);
    suite.install();
    try {
      const { network } = suite.begin(evalNetwork());
      await expect(
        globalThis.fetch("https://llm-gateway.assemblyai.com/v1/chat/completions"),
      ).rejects.toThrow(/refused/);
      expect(real).not.toHaveBeenCalled();
      expect(network.refused()).toHaveLength(1);
    } finally {
      suite.end();
      suite.restore();
    }
  });

  test("a request AFTER the case ended is refused into that case's log, never let out", async () => {
    const real = vi.fn<typeof fetch>(async () => new Response("leaked"));
    globalThis.fetch = real;
    const suite = suiteNetwork("stub", []);
    suite.install();
    try {
      const { network } = suite.begin(evalNetwork({ routes: { "crm.example": () => ({}) } }));
      suite.end();
      // A late `onSessionEnd` writing the call's outcome: still routed, since
      // the network that owns the route is the one it lands in.
      expect((await globalThis.fetch("https://crm.example/calls")).status).toBe(200);
      await expect(globalThis.fetch("https://api.twilio.com/Calls")).rejects.toThrow(/refused/);
      expect(network.requests().map((r) => r.outcome)).toEqual(["routed", "refused"]);
      expect(real).not.toHaveBeenCalled();
    } finally {
      suite.restore();
    }
  });

  test("before any case, a request is refused outright", async () => {
    const suite = suiteNetwork("stub", []);
    suite.install();
    try {
      await expect(globalThis.fetch("https://api.twilio.com/Calls")).rejects.toThrow(
        /no eval case is running/,
      );
    } finally {
      suite.restore();
    }
  });

  test("a factory is called per begin; an instance has its log reset per begin", async () => {
    const suite = suiteNetwork("stub", []);
    const factory = vi.fn(() => evalNetwork({ routes: { "ok.example": () => ({}) } }));
    const first = suite.begin(factory).network;
    const second = suite.begin(factory).network;
    expect(factory).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);

    const shared = evalNetwork({ routes: { "ok.example": () => ({}) } });
    await suite.begin(shared).fetch("https://ok.example/");
    expect(shared.requests()).toHaveLength(1);
    suite.begin(shared);
    expect(shared.requests()).toEqual([]);
    suite.end();
  });
});

describe("stepFetchOver", () => {
  test("hands a step's request to the fetch, a streamed body read whole", async () => {
    const net = evalNetwork({
      routes: { "sms.example": async (request) => ({ got: await request.text() }) },
    });
    async function* chunks() {
      yield new TextEncoder().encode("hello ");
      yield new TextEncoder().encode("world");
    }
    const response = await stepFetchOver(net.fetch)("https://sms.example/send", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: chunks(),
    });
    expect(await response.json()).toEqual({ got: "hello world" });
    expect(net.requests()[0]?.method).toBe("POST");
  });
});

describe("wantsNetwork", () => {
  test("the suite's own network, or any case's, installs one; none installs nothing", () => {
    const net = evalNetwork();
    expect(wantsNetwork(net, [])).toBe(true);
    expect(wantsNetwork(undefined, [undefined, { network: net }])).toBe(true);
    expect(wantsNetwork(undefined, [undefined, { live: true }])).toBe(false);
  });
});
