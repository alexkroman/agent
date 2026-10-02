// Copyright 2026 the AAI authors. MIT license.
/**
 * The step-fetch fake every published stub is built on: the recorder, the
 * answer encoding, and the publish/unpublish pair.
 *
 * `routeStepFetch`'s spec, which used to live here, is ported into
 * `testing-fetch-routes.test.ts` with the fold into `stubFetchRoutes`.
 */
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { publishAnsweringStepFetch, stubStepFetch, toStepResponse } from "./_testing-step-fetch.ts";
import { stepFetch } from "./step-fetch.ts";

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

describe("toStepResponse", () => {
  test("a whole Response passes through as the same object", () => {
    const res = new Response("raw", { status: 418 });
    expect(toStepResponse(res)).toBe(res);
  });

  test("the shorthand JSON-encodes its body with a JSON content type", async () => {
    const res = toStepResponse({ status: 201, body: { id: 1 }, headers: { "X-Trace": "t" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Trace")).toBe("t");
    expect(await res.json()).toEqual({ id: 1 });
  });

  test("a string body is sent as written, and no body is an empty object", async () => {
    expect(await toStepResponse({ body: "plain" }).text()).toBe("plain");
    expect(await toStepResponse({}).json()).toEqual({});
  });

  test.for([204, 205, 304])(
    "a null-body status %i answers with no body instead of throwing",
    async (status) => {
      const res = toStepResponse({ status, body: { ignored: true } });
      expect(res.status).toBe(status);
      expect(await res.text()).toBe("");
    },
  );
});

describe("stubStepFetch", () => {
  test("records each request in order, a streaming body drained to bytes", async () => {
    const net = stubStepFetch();
    onTestFinished(net.restore);

    await stepFetch("https://a.test/one");
    await stepFetch("https://a.test/two", {
      method: "POST",
      headers: { Authorization: "sk-test" },
      body: chunks("he", "llo"),
    });

    expect(net.calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "https://a.test/one"],
      ["POST", "https://a.test/two"],
    ]);
    expect(net.calls[1]?.headers).toEqual({ Authorization: "sk-test" });
    expect(new TextDecoder().decode(net.calls[1]?.body as Uint8Array)).toBe("hello");
  });

  test("answers with what the handler returned", async () => {
    const net = stubStepFetch((request) => ({ body: { echoed: request.url } }));
    onTestFinished(net.restore);
    expect(await (await stepFetch("https://a.test/x")).json()).toEqual({
      echoed: "https://a.test/x",
    });
  });
});

describe("publishAnsweringStepFetch", () => {
  test("publishes until the returned unpublish, which hands stepFetch back to the global", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("global")),
    );
    const unpublish = publishAnsweringStepFetch(() => ({ body: "stubbed" }));
    onTestFinished(unpublish);
    expect(await (await stepFetch("https://a.test/")).text()).toBe("stubbed");

    unpublish();
    expect(await (await stepFetch("https://a.test/")).text()).toBe("global");
  });
});
