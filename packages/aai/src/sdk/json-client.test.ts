// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { HttpError, jsonClient } from "./json-client.ts";

function answering(status: number, body: string) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(body === "" && status === 204 ? null : body, { status }),
  );
}

const env = { API_KEY: "k-1", API_URL: "https://svc.example.com/v2/" };

describe("jsonClient", () => {
  test("sends JSON with the env-derived headers and parses the answer", async () => {
    const fetch = answering(200, '{"id":7}');
    const call = jsonClient({
      baseUrl: (e) => e.API_URL ?? "",
      headers: (e) => ({ authorization: `Token ${e.API_KEY}` }),
      label: "svc",
      fetch,
    });
    const signal = new AbortController().signal;
    const out = await call<{ id: number }>(
      { env, signal },
      "POST",
      "/things",
      { a: 1 },
      {
        headers: { prefer: "return=minimal" },
      },
    );
    expect(out).toEqual({ id: 7 });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://svc.example.com/v2/things");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"a":1}');
    expect(init?.signal).toBe(signal);
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Token k-1",
      prefer: "return=minimal",
    });
  });

  test("an empty body is {} and a bodyless GET sends no body", async () => {
    const fetch = answering(204, "");
    const call = jsonClient({ baseUrl: "https://svc.example.com", label: "svc", fetch });
    expect(await call({ env }, "GET", "/x")).toEqual({});
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  test("a refusal throws HttpError with the status, the service's sentence and the body", async () => {
    const body = { error: { message: "Validation error", request_id: "r-9" } };
    const call = jsonClient({
      baseUrl: "https://svc.example.com",
      label: "Composio",
      errorMessage: (b) => {
        const e = (b as typeof body).error;
        return `${e.message} (request ${e.request_id})`;
      },
      fetch: answering(422, JSON.stringify(body)),
    });
    const err = await call({ env }, "POST", "/x", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({
      status: 422,
      message: "Composio 422: Validation error (request r-9)",
      body,
    });
  });

  test("without errorMessage, { error } and { message } shapes are read", async () => {
    const call = (text: string) =>
      jsonClient({ baseUrl: "https://s", label: "svc", fetch: answering(400, text) })(
        { env },
        "GET",
        "/",
      );
    await expect(call('{"error":"bad id"}')).rejects.toThrow("svc 400: bad id");
    await expect(call('{"message":"nope"}')).rejects.toThrow("svc 400: nope");
    await expect(call('{"error":{"message":"deep"}}')).rejects.toThrow("svc 400: deep");
  });

  test("an unreadable refusal falls back to a marked preview of the raw text", async () => {
    const html = `<html>${"x".repeat(400)}</html>`;
    const err = (await jsonClient({
      baseUrl: "https://s",
      label: "svc",
      fetch: answering(502, html),
    })({ env }, "GET", "/").catch((e: unknown) => e)) as HttpError;
    expect(err.status).toBe(502);
    expect(err.message.startsWith("svc 502: <html>")).toBe(true);
    expect(err.message.endsWith("…")).toBe(true);
    expect(err.body).toBe(html);
    const bare = (await jsonClient({
      baseUrl: "https://s",
      label: "svc",
      fetch: answering(500, ""),
    })({ env }, "GET", "/").catch((e: unknown) => e)) as HttpError;
    expect(bare.message).toBe("svc 500");
    expect(bare.body).toBeUndefined();
  });

  test("a 2xx that is not JSON is an HttpError too, not a bare SyntaxError", async () => {
    const call = jsonClient({
      baseUrl: "https://s",
      label: "svc",
      fetch: answering(200, "<p>hi</p>"),
    });
    await expect(call({ env }, "GET", "/")).rejects.toMatchObject({
      name: "HttpError",
      status: 200,
      message: "svc 200: <p>hi</p>",
    });
  });

  test("a headers function that throws (a missing key) rejects before any request", async () => {
    const fetch = answering(200, "{}");
    const call = jsonClient({
      baseUrl: "https://s",
      label: "svc",
      headers: () => {
        throw new Error("MEM0_API_KEY is not set");
      },
      fetch,
    });
    await expect(call({ env }, "GET", "/")).rejects.toThrow("MEM0_API_KEY is not set");
    expect(fetch).not.toHaveBeenCalled();
  });
});
