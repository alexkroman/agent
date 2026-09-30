// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { COMPOSIO_BASE_URL, composioApi, composioErrorMessage } from "./composio-api.ts";
import { HttpError } from "./json-client.ts";
import { type StubFetchRoutes, stubFetchRoutes } from "./testing-fetch-routes.ts";

// The REST client under `composio()`: Composio's error body made one sentence,
// the key sent as the header and scrubbed from every refusal, and a non-https
// base URL refused before any request.

const KEY = "ak_test_secret";
const ctx = { env: { COMPOSIO_API_KEY: KEY } };
const HOST = new URL(COMPOSIO_BASE_URL).host;

let net: StubFetchRoutes | undefined;
afterEach(() => net?.restore());

describe("composioErrorMessage", () => {
  test("keeps the message, which fields failed, and the request id", () => {
    expect(
      composioErrorMessage({
        error: {
          message: "Validation error",
          errors: ["tool_slug: required", "arguments: expected object"],
          request_id: "req_9",
        },
      }),
    ).toBe("Validation error: tool_slug: required; arguments: expected object (request req_9)");
    expect(composioErrorMessage({ error: { message: "Nope" } })).toBe("Nope");
    expect(composioErrorMessage({ message: "flat" })).toBeUndefined();
  });
});

describe("composioApi", () => {
  test("a refusal throws an HttpError carrying that detail, and never the key", async () => {
    net = stubFetchRoutes({
      [HOST]: () => ({
        status: 400,
        body: {
          error: { message: `bad key ${KEY}`, errors: ["user_id: missing"], request_id: "req_1" },
        },
      }),
    });
    const err = await composioApi()(ctx, "GET", "/toolkits").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const http = err as HttpError;
    expect(http.status).toBe(400);
    expect(http.message).toBe("Composio 400: bad key [redacted]: user_id: missing (request req_1)");
    expect(JSON.stringify(http.body)).not.toContain(KEY);
    // The key went out as the header, and only there.
    expect(net.hits[0]?.headers["x-api-key"]).toBe(KEY);
  });

  test("a key quoted URL-encoded, or in a secret-named query parameter, is scrubbed too", async () => {
    const odd = "ak/with+chars";
    net = stubFetchRoutes({
      [HOST]: () => ({
        status: 400,
        body: {
          error: {
            message: `see https://x.test/?key=${encodeURIComponent(odd)} and ?token=other`,
          },
        },
      }),
    });
    const err = (await composioApi()({ env: { COMPOSIO_API_KEY: odd } }, "GET", "/toolkits").catch(
      (e: unknown) => e,
    )) as HttpError;
    expect(err.message).not.toContain(encodeURIComponent(odd));
    expect(err.message).not.toContain("other");
    expect(JSON.stringify(err.body)).not.toContain(encodeURIComponent(odd));
    expect(err.cause).toBeUndefined();
  });

  test("the key is read from apiKeyEnv, per call", async () => {
    net = stubFetchRoutes({ [HOST]: () => ({ body: { ok: 1 } }) });
    const api = composioApi({ apiKeyEnv: "MY_COMPOSIO" });
    expect(await api({ env: { MY_COMPOSIO: "k2" } }, "GET", "/toolkits")).toEqual({ ok: 1 });
    expect(net.hits[0]?.headers["x-api-key"]).toBe("k2");
  });

  test("a baseUrl that is not https is refused at construction", () => {
    expect(() => composioApi({ baseUrl: "http://backend.composio.dev/api/v3.1" })).toThrow(/https/);
  });
});
