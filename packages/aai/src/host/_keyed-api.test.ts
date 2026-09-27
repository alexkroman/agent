// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { fetchKeyedJson, type KeyedApiRequest } from "./_keyed-api.ts";
import { fakeFetch } from "./_test-utils.ts";

function request(response: Response | Error, extra?: Partial<KeyedApiRequest>) {
  const mockFetch = vi.fn((_url: string, _init: RequestInit) =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  const req: KeyedApiRequest = {
    service: "Example API",
    keyEnv: "EXAMPLE_KEY",
    keyHint: "has the Example product enabled",
    url: "https://api.example.com/v1/search",
    headers: (key) => ({ "X-Api-Key": key }),
    fetch: fakeFetch(mockFetch),
    ...extra,
  };
  return { mockFetch, req };
}

const withKey = { env: { EXAMPLE_KEY: " secret " } };

describe("fetchKeyedJson", () => {
  test("sends the trimmed key through the service's own header and parses the body", async () => {
    const { mockFetch, req } = request(Response.json({ hits: 3 }));
    await expect(fetchKeyedJson(withKey, req)).resolves.toEqual({ ok: true, value: { hits: 3 } });
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.com/v1/search");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("secret");
    expect(headers.Accept).toBe("application/json");
    expect(init?.method).toBeUndefined();
  });

  test("a body makes the request a POST", async () => {
    const { mockFetch, req } = request(Response.json({}), { body: '{"q":"x"}' });
    await fetchKeyedJson(withKey, req);
    const init = mockFetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"q":"x"}');
  });

  test("an unset or blank key is refused before any request, naming the variable", async () => {
    for (const env of [{}, { EXAMPLE_KEY: "   " }]) {
      const { mockFetch, req } = request(Response.json({}));
      const result = await fetchKeyedJson({ env }, req);
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Missing EXAMPLE_KEY"),
      });
      expect(mockFetch).not.toHaveBeenCalled();
    }
  });

  test.each([401, 403])("%i is a rejected key, with the service's hint", async (status) => {
    const { req } = request(new Response("", { status, statusText: "Nope" }));
    await expect(fetchKeyedJson(withKey, req)).resolves.toEqual({
      ok: false,
      error: `Example API rejected EXAMPLE_KEY (${status} Nope) — check the key is valid and has the Example product enabled`,
    });
  });

  test("a service-specific rejection status joins 401/403, and is otherwise a plain failure", async () => {
    const bad = () => new Response("", { status: 400, statusText: "Bad Request" });
    const opted = request(bad(), { rejectedStatuses: [400] });
    await expect(fetchKeyedJson(withKey, opted.req)).resolves.toMatchObject({
      error: expect.stringContaining("rejected EXAMPLE_KEY"),
    });
    const plain = request(bad());
    await expect(fetchKeyedJson(withKey, plain.req)).resolves.toEqual({
      ok: false,
      error: "Example API request failed: 400 Bad Request",
    });
  });

  test("429 says to retry", async () => {
    const { req } = request(new Response("", { status: 429, statusText: "Too Many Requests" }));
    await expect(fetchKeyedJson(withKey, req)).resolves.toEqual({
      ok: false,
      error: "Example API rate limit reached (429 Too Many Requests) — try again shortly",
    });
  });

  test("a thrown fetch and an unparseable body are failures, not throws", async () => {
    const thrown = request(new Error("socket hang up"));
    await expect(fetchKeyedJson(withKey, thrown.req)).resolves.toEqual({
      ok: false,
      error: "Example API request failed: socket hang up",
    });
    const garbled = request(new Response("<html>"));
    await expect(fetchKeyedJson(withKey, garbled.req)).resolves.toEqual({
      ok: false,
      error: "Example API request failed: Response was not valid JSON",
    });
  });
});
