// Copyright 2026 the AAI authors. MIT license.
/**
 * The one request the four platform clients make.
 *
 * They each used to make it themselves, so what is worth pinning here is the half
 * that was never the same in all four copies — and one case that no client's own
 * suite could reach, because a `fetch` fake returning a `Response` cannot produce
 * a body that fails MID-READ:
 *
 * - **A non-2xx whose body will not read still names the status.** Three of the
 *   four read the reply unguarded before checking `res.ok`, so a platform
 *   answering 503 while its connection dropped rejected with the stream error and
 *   threw the status away — indistinguishable from a network fault, on the one
 *   axis that decides whether a step should be retried.
 * - **A status the caller reads as something else is decided from the STATUS
 *   alone**, before the body is touched. The upload records client's 409 is
 *   `claim` refusing an id, and what the platform said about a refused id does
 *   not change what a refused id means.
 * - **The deadline is named in the timeout message.** The four are 10s, 15s, 15s
 *   and 20s, set for four different reasons, and "which deadline elapsed" is the
 *   actionable fact on a step that failed with nothing else stated.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { PLATFORM_ROUTES } from "./platform-endpoint.ts";
import { platformBearer, platformPost, platformResult } from "./platform-rpc.ts";

const BASE = "https://api.test/my-agent";
const TOKEN = "sandbox-bearer";

/** A call with everything but the parts a case is about. */
const CALL = {
  route: PLATFORM_ROUTES.sessionState,
  label: "session-state load",
  timeoutMs: 10_000,
  body: JSON.stringify({ method: "load" }),
};

function recordingPlatform(answer: () => Response = () => Response.json({ result: null })) {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: await req.text() });
    return answer();
  };
  return { calls, fetch };
}

const endpoint = (fetch: typeof globalThis.fetch) => ({ base: BASE, token: TOKEN, fetch });

afterEach(() => {
  vi.useRealTimers();
});

describe("what crosses to the platform", () => {
  test("posts the body to the route's URL, with the bearer and a JSON content type", async () => {
    const platform = recordingPlatform();
    await platformPost(endpoint(platform.fetch), CALL);
    expect(platform.calls).toHaveLength(1);
    const [call] = platform.calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.test/my-agent/session-state");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.body).toBe(CALL.body);
  });

  test("tolerates a trailing slash on the operator-set base", async () => {
    const platform = recordingPlatform();
    await platformPost({ base: `${BASE}/`, token: TOKEN, fetch: platform.fetch }, CALL);
    expect(platform.calls[0]?.url).toBe("https://api.test/my-agent/session-state");
  });

  test("carries a W3C traceparent, so the platform's own lines can be joined", async () => {
    const platform = recordingPlatform();
    await platformPost(endpoint(platform.fetch), CALL);
    // The header the SERVER parses (`aai-server/_platform-route.ts`), asserted
    // against the grammar rather than a fixture — there is nothing to fix here,
    // and a shape the parser refuses is a correlation key that silently never
    // correlates.
    expect(platform.calls[0]?.headers.get("traceparent")).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
  });

  test("mints a fresh trace per call — one span per RPC", async () => {
    const platform = recordingPlatform();
    await platformPost(endpoint(platform.fetch), CALL);
    await platformPost(endpoint(platform.fetch), CALL);
    const [first, second] = platform.calls;
    expect(first?.headers.get("traceparent")).not.toBe(second?.headers.get("traceparent"));
  });

  test("the bearer is one spelling, which both ends of the wire read", () => {
    // Five call sites wrote this out; a scheme that disagrees with the server's
    // parser by a character is a 401 with nothing naming the header.
    expect(platformBearer(TOKEN)).toEqual({ authorization: "Bearer sandbox-bearer" });
  });
});

describe("a reply that is not 2xx", () => {
  test.each([400, 401, 404, 501, 503])("names the label, the status and the reply", async (s) => {
    const platform = recordingPlatform(() => Response.json({ error: "no room" }, { status: s }));
    await expect(platformPost(endpoint(platform.fetch), CALL)).rejects.toThrow(
      new RegExp(`session-state load answered HTTP ${s}[\\s\\S]*no room`),
    );
  });

  test("caps the platform's reply at 500 characters", async () => {
    const platform = recordingPlatform(() => new Response("x".repeat(900), { status: 500 }));
    await expect(platformPost(endpoint(platform.fetch), CALL)).rejects.toThrow(
      /answered HTTP 500: x{500}$/,
    );
  });

  test("still carries the status when the reply body cannot be read", async () => {
    // The regression this shared body exists to prevent. A `Response` whose stream
    // errors is what a platform answering 503 on a dropping connection produces,
    // and the three clients that read it unguarded reported the stream error with
    // no status — which is the one fact that decides whether to retry.
    const platform = recordingPlatform(
      () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.error(new Error("connection reset")),
          }),
          { status: 503 },
        ),
    );
    await expect(platformPost(endpoint(platform.fetch), CALL)).rejects.toThrow(
      /session-state load answered HTTP 503/,
    );
  });

  test("a status the caller claims becomes ITS error, not the generic one", async () => {
    const platform = recordingPlatform(() => Response.json({ error: "taken" }, { status: 409 }));
    await expect(
      platformPost(endpoint(platform.fetch), {
        ...CALL,
        errorFor: (status) => (status === 409 ? new Error("id already claimed") : undefined),
      }),
    ).rejects.toThrow(/id already claimed/);
  });

  test("a claimed status does not depend on the reply body being readable", async () => {
    // Decided from the status alone, before the body is touched: what the platform
    // said about a refused id does not change what a refused id means.
    const platform = recordingPlatform(
      () =>
        new Response(
          new ReadableStream({ start: (controller) => controller.error(new Error("gone")) }),
          { status: 409 },
        ),
    );
    await expect(
      platformPost(endpoint(platform.fetch), {
        ...CALL,
        errorFor: (status) => (status === 409 ? new Error("id already claimed") : undefined),
      }),
    ).rejects.toThrow(/id already claimed/);
  });

  test("a caller's own error is handed the platform's reply, for the ones that need it", async () => {
    // Storage's 404 becomes the DevKit's `WorkflowRunNotFoundError` and carries
    // the platform's message; the upload records client's 409 ignores it.
    const platform = recordingPlatform(() => new Response("no such run", { status: 404 }));
    await expect(
      platformPost(endpoint(platform.fetch), {
        ...CALL,
        errorFor: (status, detail) => new Error(`translated ${status}: ${detail}`),
      }),
    ).rejects.toThrow(/translated 404: no such run/);
  });

  test("a status the caller does NOT claim falls through to the generic error", async () => {
    const platform = recordingPlatform(() => Response.json({ error: "no" }, { status: 503 }));
    await expect(
      platformPost(endpoint(platform.fetch), {
        ...CALL,
        errorFor: (status) => (status === 409 ? new Error("id already claimed") : undefined),
      }),
    ).rejects.toThrow(/answered HTTP 503/);
  });
});

test("a hung socket fails with the label and the deadline that elapsed", async () => {
  vi.useFakeTimers();
  // A socket nobody ever answers: the deadline is the only thing that settles this.
  const hung = Promise.withResolvers<Response>();
  const call = platformPost(
    { base: BASE, token: TOKEN, fetch: () => hung.promise },
    { ...CALL, timeoutMs: 10_000 },
  );
  const settled = expect(call).rejects.toThrow(/session-state load timed out after 10000ms/);
  await vi.advanceTimersByTimeAsync(10_000);
  await settled;
});

test("a transport failure propagates rather than being swallowed", async () => {
  await expect(
    platformPost(
      {
        base: BASE,
        token: TOKEN,
        fetch: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      },
      CALL,
    ),
  ).rejects.toThrow(/ECONNREFUSED/);
});

describe("the `{result}` envelope", () => {
  test("unwraps result rather than handing back the envelope", async () => {
    const platform = recordingPlatform(() => Response.json({ result: { slot: "value" } }));
    await expect(platformResult(endpoint(platform.fetch), CALL)).resolves.toEqual({
      slot: "value",
    });
  });

  test("passes a null result through, which is a legitimate answer", async () => {
    // `"result" in parsed`, not a truthiness test: `null` is "no such record", and
    // three of the routes answer it routinely.
    const platform = recordingPlatform(() => Response.json({ result: null }));
    await expect(platformResult(endpoint(platform.fetch), CALL)).resolves.toBeNull();
  });

  test.each([
    ["no result key", () => Response.json({ ok: true })],
    ["a bare array", () => Response.json([1, 2])],
    ["a JSON scalar", () => Response.json(7)],
  ])("rejects a 200 with %s rather than reading as undefined", async (_label, answer) => {
    const platform = recordingPlatform(answer);
    await expect(platformResult(endpoint(platform.fetch), CALL)).rejects.toThrow(
      /session-state load answered 200 without a result/,
    );
  });
});
