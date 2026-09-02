// Copyright 2026 the AAI authors. MIT license.

import { requestPath } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { createSessionEventStream, type SessionEventStream } from "./session-event-stream.ts";
import {
  createSessionEventsApi,
  SESSION_EVENTS_PATH,
  type SessionEventsRequest,
  type SessionEventsResponse,
} from "./session-events-api.ts";
import { createMemoryStateBackend } from "./session-state-store.ts";

const SID = "s-1";
const TOKEN = "tok";

/**
 * A response recorder.
 *
 * A plain object rather than a cast `ServerResponse`, which is what
 * {@link SessionEventsResponse} exists for: the route names the members it
 * touches, so the double satisfies them honestly and a change to that surface
 * fails HERE instead of being laundered past the checker.
 */
function makeRes() {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    writeHead: vi.fn((status: number, _headers?: unknown) => {
      res.statusCode = status;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn((chunk?: string) => {
      if (chunk !== undefined) res.body = chunk;
      return res;
    }),
    destroy: vi.fn(),
  };
  return res satisfies Record<keyof SessionEventsResponse, unknown> & { body: string };
}

function makeReq(url: string, token?: string): SessionEventsRequest {
  return { url, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } };
}

/**
 * Drive one request.
 *
 * `bearer` is a PROPERTY rather than a positional default, because passing
 * `undefined` positionally selects the default — so "send no bearer" and "send
 * the right one" were the same call, and the 401 cases passed while sending a
 * valid token.
 */
async function call(
  opts: {
    stream?: SessionEventStream | undefined;
    /** Absent means the route is configured with {@link TOKEN}. */
    token?: string | undefined;
    /** Absent means the request presents no `Authorization` header. */
    bearer?: string;
    method?: string;
  },
  url: string,
) {
  const api = createSessionEventsApi({
    stream: () => opts.stream,
    ...("token" in opts ? { token: opts.token } : { token: TOKEN }),
    logger: silentLogger,
  });
  const res = makeRes();
  // `createServer` strips the query before dispatching, and passes the full URL
  // on the request — so the helper models both halves rather than one.
  const claimed = api(makeReq(url, opts.bearer), res, requestPath(url), opts.method ?? "GET");
  // The handler claims synchronously and answers from a promise. `waitUntil`
  // rather than `waitFor(() => expect(...))`: an assertion outside a `test()`
  // body is what `noMisplacedAssertion` exists to catch, and this is a helper.
  await vi.waitUntil(() => res.end.mock.calls.length > 0);
  return { claimed, res, json: () => JSON.parse(res.body) as Record<string, unknown> };
}

function seeded(): SessionEventStream {
  const stream = createSessionEventStream({ backend: createMemoryStateBackend() });
  stream.append(SID, { type: "user-transcript.committed", text: "one" });
  stream.append(SID, { type: "agent-transcript.committed", text: "two" });
  return stream;
}

describe("GET /session-events/:id", () => {
  test("answers the page and the tail", async () => {
    const { res, json } = await call(
      { stream: seeded(), bearer: TOKEN },
      `${SESSION_EVENTS_PATH}/${SID}`,
    );

    expect(res.statusCode).toBe(200);
    expect(json()).toMatchObject({ sessionId: SID, startIndex: 0, tail: 2, durable: false });
    expect((json().events as unknown[]).length).toBe(2);
  });

  test("startIndex selects a position", async () => {
    const { json } = await call(
      { stream: seeded(), bearer: TOKEN },
      `${SESSION_EVENTS_PATH}/${SID}?startIndex=1`,
    );
    expect(json()).toMatchObject({ startIndex: 1, tail: 2 });
    expect((json().events as unknown[]).length).toBe(1);
  });

  test("a negative startIndex counts back from the end", async () => {
    // The same vocabulary as the workflow progress stream's `startIndex`, so
    // "the last N" is spelled one way across both surfaces.
    const { json } = await call(
      { stream: seeded(), bearer: TOKEN },
      `${SESSION_EVENTS_PATH}/${SID}?startIndex=-1`,
    );
    expect(json()).toMatchObject({ startIndex: 1 });
  });

  test("a nonsense startIndex reads from the start rather than failing", async () => {
    const { res, json } = await call(
      { stream: seeded(), bearer: TOKEN },
      `${SESSION_EVENTS_PATH}/${SID}?startIndex=banana`,
    );
    expect(res.statusCode).toBe(200);
    expect(json()).toMatchObject({ startIndex: 0 });
  });

  test("a startIndex past the safe integer range is CLAMPED, not passed on", async () => {
    // `Number.isFinite` was the only bound, and the index goes to a `bigint`
    // column: `1e30` reaches the driver as the string "1e+30" (a syntax error)
    // and anything over ~9.22e18 as out-of-range. Measured on Postgres under
    // `aai dev`, both answered `500 Internal server error` for what is a
    // query-string typo. Nothing is lost by clamping — MAX_SAFE_INTEGER is
    // already past the end of every stream, so the page is empty either way.
    for (const raw of ["1e30", "9223372036854775808", "99999999999999999999"]) {
      const { res, json } = await call(
        { stream: seeded(), bearer: TOKEN },
        `${SESSION_EVENTS_PATH}/${SID}?startIndex=${raw}`,
      );
      expect(res.statusCode, raw).toBe(200);
      expect(json(), raw).toMatchObject({ startIndex: Number.MAX_SAFE_INTEGER });
      expect((json().events as unknown[]).length, raw).toBe(0);
    }
  });

  test("an index inside the safe range is passed through untouched", async () => {
    // The clamp is a ceiling, not a rewrite: everything a real cursor can hold
    // still reaches the backend as itself.
    const { json } = await call(
      { stream: seeded(), bearer: TOKEN },
      `${SESSION_EVENTS_PATH}/${SID}?startIndex=${Number.MAX_SAFE_INTEGER}`,
    );
    expect(json()).toMatchObject({ startIndex: Number.MAX_SAFE_INTEGER });
  });

  test("an unknown session is an empty log, not an error", async () => {
    // A session id is unguessable, so "no such session" and "nothing recorded"
    // are not worth distinguishing to a caller — and distinguishing them would
    // make this an existence oracle.
    const { res, json } = await call(
      { stream: seeded(), bearer: TOKEN },
      `${SESSION_EVENTS_PATH}/nope`,
    );
    expect(res.statusCode).toBe(200);
    expect(json()).toMatchObject({ events: [], tail: 0 });
  });

  test("`durable` reports whether a read can outlive the process", async () => {
    // An empty page on the memory tier means something different from an empty
    // page on Postgres, and a caller cannot tell without being told.
    const { json } = await call(
      { stream: seeded(), bearer: TOKEN },
      `${SESSION_EVENTS_PATH}/${SID}`,
    );
    expect(json().durable).toBe(false);
  });
});

describe("session events API — the gate", () => {
  test("with no token configured the route 404s", async () => {
    const { res, json } = await call(
      { stream: seeded(), token: undefined },
      `${SESSION_EVENTS_PATH}/${SID}`,
    );

    // Closed by DEFAULT, unlike the workflow API — nothing in the product reads
    // this and its content is the conversation. A 404 rather than a 401 says the
    // true thing: this agent does not serve that.
    expect(res.statusCode).toBe(404);
    expect(String(json().error)).toContain("AAI_SESSION_EVENTS_TOKEN");
  });

  test("a missing bearer is 401", async () => {
    const { res } = await call({ stream: seeded() }, `${SESSION_EVENTS_PATH}/${SID}`);
    expect(res.statusCode).toBe(401);
  });

  /**
   * The set-but-EMPTY token, which served the conversation to anyone.
   *
   * The FAILING observation, measured on this harness before the guard: status
   * **200**, with both seeded transcript events in the body, to a request
   * carrying no `Authorization` header at all. `""` is not `undefined` so the
   * route turned ON, and `bearerMatches(header, "")` compared two empty buffers,
   * which `timingSafeEqual` matches. This is the higher-severity half of the
   * bypass because this route is CLOSED by default and its content is the
   * conversation — transcripts, tool arguments, the caller's own words — and the
   * value is reachable from the studio's Secrets pane, whose
   * `SecretUpdatesSchema` accepts an empty string.
   */
  test.each(["", "   ", "\t"])("a blank configured token (%j) authenticates nobody", async (t) => {
    const { res, json } = await call(
      { stream: seeded(), token: t },
      `${SESSION_EVENTS_PATH}/${SID}`,
    );

    expect(res.statusCode).toBe(401);
    // Asserted on the BODY as well as the status: the failure this replaces was
    // a 200 carrying the transcript, so "not 200" is only half the claim.
    expect(JSON.stringify(json())).not.toContain("one");
  });

  test("a blank token refuses a caller who presents that same blank", async () => {
    // The other direction: a caller cannot opt into the hole by sending the empty
    // credential itself, which `parseBearer` cannot distinguish from no header.
    const { res } = await call(
      { stream: seeded(), token: "", bearer: "" },
      `${SESSION_EVENTS_PATH}/${SID}`,
    );
    expect(res.statusCode).toBe(401);
  });

  test("a wrong bearer is 401", async () => {
    const { res } = await call(
      { stream: seeded(), bearer: "nope" },
      `${SESSION_EVENTS_PATH}/${SID}`,
    );
    expect(res.statusCode).toBe(401);
  });

  test("the token is checked BEFORE the runtime is resolved", async () => {
    const stream = vi.fn(() => seeded());
    const api = createSessionEventsApi({ stream, token: TOKEN, logger: silentLogger });
    const res = makeRes();
    const url = `${SESSION_EVENTS_PATH}/${SID}`;

    // NO bearer: an unauthenticated caller must not be able to trigger it.
    api(makeReq(url), res, url, "GET");
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());

    // Resolving builds the runtime in the guest, which an unauthenticated caller
    // must not be able to trigger.
    expect(stream).not.toHaveBeenCalled();
  });

  test("a non-GET method is 405", async () => {
    const { res } = await call(
      { stream: seeded(), bearer: TOKEN, method: "DELETE" },
      `${SESSION_EVENTS_PATH}/${SID}`,
    );
    expect(res.statusCode).toBe(405);
  });

  test("a server with no runtime answers 503, not an empty log", async () => {
    const { res } = await call(
      { stream: undefined, bearer: TOKEN },
      `${SESSION_EVENTS_PATH}/${SID}`,
    );
    expect(res.statusCode).toBe(503);
  });
});

describe("session events API — routing", () => {
  test("claims only its own prefix", () => {
    const api = createSessionEventsApi({
      stream: () => seeded(),
      token: TOKEN,
      logger: silentLogger,
    });
    const res = makeRes();
    const other = "/workflows/runs";

    expect(api(makeReq(other), res, other, "GET")).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });

  test.each(["%", "%A", "%zz", "%C0%80"])(
    "a session id that will not decode (%s) is a 400, not a 500",
    async (id) => {
      // `decodeURIComponent` throws URIError on each of these. Here it landed in
      // the router's catch and reported "the agent is broken" for a request the
      // caller malformed; the module now decodes through `decodePathSegment`,
      // like the four sibling sites. Checked AFTER the bearer, so a bad path
      // cannot probe an unauthenticated 400.
      const { res, json } = await call(
        { stream: seeded(), bearer: TOKEN },
        `${SESSION_EVENTS_PATH}/${id}`,
      );
      expect(res.statusCode).toBe(400);
      expect(json()).toEqual({ error: "Malformed session id" });
    },
  );

  test("the bare prefix is not a session", async () => {
    const api = createSessionEventsApi({
      stream: () => seeded(),
      token: TOKEN,
      logger: silentLogger,
    });
    const res = makeRes();
    expect(api(makeReq(SESSION_EVENTS_PATH), res, SESSION_EVENTS_PATH, "GET")).toBe(false);
  });
});
