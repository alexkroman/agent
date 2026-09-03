// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow API's ROUTER: what it claims, who it admits, what it dispatches
 * to, and the single answer a claimed request always receives.
 *
 * Split from `workflow-api.test.ts` at the seam that file already had. The four
 * blocks here are `workflow-api.ts`'s own decisions — `claimUnder`'s predicate,
 * the token gate ahead of the engine resolution, the resolution's three answers
 * (a client, `undefined`, a throw), the route table's ordering, and the catch
 * that turns a route's rejection into exactly one response. What stays behind is
 * the five RUN endpoints, whose subject is `workflow-api-runs.ts` and
 * `workflow-api-stream.ts`.
 *
 * Named for the decision rather than the module, because two files already
 * carry a piece of this surface's unit coverage —
 * `workflow-api-runs.test.ts` (the `limit` a caller supplies) and
 * `workflow-api-run-id.test.ts` (the id in a path) — and a third named after
 * either would read as their duplicate.
 *
 * Driven through a REAL `node:http` server via the shared harness
 * (`workflow-api-test-utils.ts`), because every claim here is an HTTP one: a
 * status code, a header, or the absence of a second write to a socket.
 */

import type http from "node:http";
import { WORKFLOWS_UNAVAILABLE_MESSAGE } from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { createWorkflowApi } from "./workflow-api.ts";
import { fakeClient, type Harness, run, serve } from "./workflow-api-test-utils.ts";
import type { UploadStore } from "./workflow-uploads.ts";

let harness: Harness | undefined;

beforeEach(() => {
  harness = undefined;
});

afterEach(async () => {
  await harness?.close();
});

describe("routing", () => {
  test("does not claim a request outside the prefix", async () => {
    const claimed = createWorkflowApi({ engine: () => fakeClient(), logger: makeLogger() })(
      {} as http.IncomingMessage,
      {} as http.ServerResponse,
      "/workflowsomething",
      "GET",
    );
    expect(claimed).toBe(false);
  });

  test("claims the bare prefix and lists the declared workflows", async () => {
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      workflows: [{ name: "digest", description: "Research a topic" }],
    });
  });

  test("a claimed path with no matching method answers 404", async () => {
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows`, { method: "DELETE" });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });

  /**
   * A path with one segment too many, on a verb that has a PREFIX rule.
   *
   * The FAILING observation: `GET /workflows/runs/wrun_1/frobnicate` matched the
   * bare `/runs/:id` rule, so `"wrun_1/frobnicate"` was parsed as a run id,
   * failed the unsafe-character check and answered
   * `400 {"error":"A run id may not be empty or contain \".\", \"/\" or \"\\\\\"."}`.
   * The id in that request is fine; what does not exist is the ROUTE — and a 400
   * tells the caller to fix the one thing that was right. Every method without a
   * prefix rule for the suffix already answered 404 (`POST` and `PUT` under
   * `/runs/` match nothing), so one class of mistake had two statuses depending
   * on the verb.
   *
   * A percent-encoded separator is deliberately NOT this case and stays a 400 —
   * see `workflow-api-run-id.test.ts`: `wrun_a%2Fb` is one path segment naming
   * an id no store can hold, not a request for a route.
   */
  test.each([
    ["GET", "/workflows/runs/wrun_1/frobnicate"],
    ["GET", "/workflows/runs/wrun_1/events/extra"],
    ["DELETE", "/workflows/runs/wrun_1/events"],
  ])("%s %s is a 404 — the id parsed, the ROUTE does not exist", async (method, path) => {
    const client = fakeClient();
    harness = await serve({ engine: () => client });
    const res = await fetch(`${harness.url}${path}`, { method });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.cancel).not.toHaveBeenCalled();
  });

  test("`/runs/:id/events` is matched before the bare `/runs/:id` GET", async () => {
    // The ordering bug this pins reads "<id>/events" as a run id, so the
    // giveaway is a 404 for a run that exists — and an SSE content type is the
    // only thing that distinguishes the two routes from outside.
    const engine = fakeClient({ get: vi.fn(async () => run({ status: "completed", output: 1 })) });
    harness = await serve({ engine: () => engine });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.text();
  });

  test("a run id is percent-decoded out of the path", async () => {
    // The vehicle used to be `a/b`, which a decoded slash now fails at the
    // router — see the unsafe-id cases below. The SUBJECT is unchanged and is
    // still worth pinning: an escape that decodes to something legal has to
    // reach the engine decoded, not raw.
    const get = vi.fn(async () => run());
    harness = await serve({ engine: () => fakeClient({ get }) });
    await fetch(`${harness.url}/workflows/runs/${encodeURIComponent("wrun_café")}`);
    expect(get).toHaveBeenCalledWith("wrun_café");
  });

  test("a malformed upload id is a 400 rather than reaching the store", async () => {
    const info = vi.fn(() => Promise.resolve(undefined));
    // `open` is what the BYTES route reaches for now, so it is what the grammar
    // check has to stop short of — asserted below beside `info`, since the two
    // read routes take different doors into the same record.
    const open = vi.fn(() => Promise.resolve(undefined));
    const uploads: UploadStore = {
      info,
      open,
      read: () => Promise.resolve(new Uint8Array()),
      create: () => Promise.resolve({ id: "upl_1", name: "", type: "", size: 0, complete: true }),
      stream: (id: string) => Promise.resolve({ id, name: "", type: "", size: 0, complete: true }),
      beginParts: (id: string) =>
        Promise.resolve({ id, name: "", type: "", size: 0, complete: false }),
      recordParts: (id: string) =>
        Promise.resolve({ id, name: "", type: "", size: 0, complete: false }),
      writePart: (id: string) =>
        Promise.resolve({ id, name: "", type: "", size: 0, complete: false }),
    };
    harness = await serve({ engine: () => fakeClient(), uploads });
    const res = await fetch(`${harness.url}/workflows/uploads/%`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Malformed upload id" });
    expect(info).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("availability", () => {
  test("an undefined engine answers 404 naming BOTH causes", async () => {
    harness = await serve({ engine: () => undefined });
    const res = await fetch(`${harness.url}/workflows`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: WORKFLOWS_UNAVAILABLE_MESSAGE });
  });

  test("an engine resolver that THROWS answers 500 carrying the reason", async () => {
    // The distinction that matters: a runtime that could not be BUILT is a
    // misconfigured agent, and answering 404 would deny that its workflows exist.
    harness = await serve({
      engine: () => {
        throw new Error("AssemblyAI LLM: missing API key");
      },
    });
    const res = await fetch(`${harness.url}/workflows`);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Workflow API unavailable: AssemblyAI LLM: missing API key",
    });
  });
});

describe("token", () => {
  test("no token leaves every route open", async () => {
    harness = await serve({ engine: () => fakeClient() });
    expect((await fetch(`${harness.url}/workflows`)).status).toBe(200);
  });

  test("a token refuses a request that does not carry it", async () => {
    harness = await serve({ engine: () => fakeClient(), token: "s3cret" });
    const res = await fetch(`${harness.url}/workflows`);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Missing or invalid workflow API token",
    });
  });

  test("a token admits a request carrying it", async () => {
    harness = await serve({ engine: () => fakeClient(), token: "s3cret" });
    const res = await fetch(`${harness.url}/workflows`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(200);
  });

  test("the engine is not resolved for an unauthorized caller", async () => {
    // Resolving builds the runtime in the guest, which is work an
    // unauthenticated caller must not be able to trigger.
    const engine = vi.fn(() => fakeClient());
    harness = await serve({ engine, token: "s3cret" });
    await fetch(`${harness.url}/workflows`);
    expect(engine).not.toHaveBeenCalled();
  });

  /**
   * The block above only ever drove `GET /workflows` — the cheapest, most
   * harmless route on the surface — so the token gate was pinned on the one
   * verb whose exposure nobody worries about, and on none of the three #1309
   * flagged: the run listing that hands out ids, and the two verbs that change a
   * run somebody else started. A token check that moved inside a route (or a
   * table entry that dispatched before the gate) would leave cancel and wake
   * open with this suite green.
   *
   * Driven as a table because the claim is identical for each and the point is
   * COVERAGE of the verb set — a loop here would report "workflow API token"
   * and not which route leaked.
   */
  test.each([
    {
      what: "the run listing (enumerates ids)",
      path: "/workflows/runs?workflow=digest",
      method: "GET",
    },
    { what: "cancel", path: "/workflows/runs/wrun_1", method: "DELETE" },
    { what: "wake", path: "/workflows/runs/wrun_1/wake", method: "POST" },
  ])("a token closes $what", async ({ path, method }) => {
    const client = fakeClient();
    harness = await serve({ engine: () => client, token: "s3cret" });

    const refused = await fetch(`${harness.url}${path}`, { method });
    expect(refused.status).toBe(401);
    // And it was refused BEFORE reaching the engine — a 401 that still ran the
    // call would have cancelled the run it was refusing.
    expect(client.recent).not.toHaveBeenCalled();
    expect(client.cancel).not.toHaveBeenCalled();
    expect(client.wakeUp).not.toHaveBeenCalled();

    const admitted = await fetch(`${harness.url}${path}`, {
      method,
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(admitted.status).toBe(200);
  });

  test("with no token those same three routes are OPEN — the documented default", async () => {
    // Pinned deliberately, and not as an endorsement: `workflow-api-auth.ts`
    // argues the posture and names closing the enumeration arm as the open
    // question. If that decision is taken, THIS is the test that has to change,
    // which is the point of writing it down as a test rather than as prose.
    const client = fakeClient();
    harness = await serve({ engine: () => client });
    for (const [path, method] of [
      ["/workflows/runs?workflow=digest", "GET"],
      ["/workflows/runs/wrun_1", "DELETE"],
      ["/workflows/runs/wrun_1/wake", "POST"],
    ] as const) {
      expect((await fetch(`${harness.url}${path}`, { method })).status).toBe(200);
    }
    expect(client.recent).toHaveBeenCalled();
    expect(client.cancel).toHaveBeenCalled();
    expect(client.wakeUp).toHaveBeenCalled();
  });

  /**
   * A set-but-EMPTY token, the third state nothing here covered.
   *
   * The FAILING observation: `bearerMatches(undefined, "")` answered `true`
   * (`timingSafeEqual` matches two empty buffers) and `workflowApiUnauthorized`
   * guarded only `token === undefined`, so `AAI_WORKFLOW_API_TOKEN=` admitted
   * every request on every route while the surface READ as closed. The two blocks
   * above pinned "no token" and "a real token" and left the misconfiguration
   * between them untested. It fails CLOSED here rather than reverting to the open
   * default — the right way round for a caller nobody can send a log line to;
   * `agentGateToken` (`server-env.test.ts`) is where a blank variable becomes
   * "absent", with the announcement.
   */
  test.each(["", "   "])("a BLANK token (%j) admits nobody", async (token) => {
    const client = fakeClient();
    harness = await serve({ engine: () => client, token });

    for (const [path, method] of [
      ["/workflows", "GET"],
      ["/workflows/runs?workflow=digest", "GET"],
      ["/workflows/runs/wrun_1", "DELETE"],
      ["/workflows/runs/wrun_1/wake", "POST"],
    ] as const) {
      // No header at all is the case that used to pass the gate — and a caller
      // cannot opt in by presenting the blank itself, `parseBearer` being unable
      // to tell `Bearer ` from no header.
      for (const headers of [{}, { Authorization: "Bearer " }]) {
        const res = await fetch(`${harness.url}${path}`, { method, headers });
        expect(res.status, path).toBe(401);
      }
    }
    expect(client.recent).not.toHaveBeenCalled();
    expect(client.cancel).not.toHaveBeenCalled();
    expect(client.wakeUp).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  test("a route that throws answers 500 rather than hanging or crashing", async () => {
    const get = vi.fn(() => Promise.reject(new Error("boom")));
    harness = await serve({ engine: () => fakeClient({ get }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1`);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal server error" });
    expect(harness.logger.error).toHaveBeenCalledWith(
      "Workflow API request failed",
      expect.objectContaining({ error: "boom" }),
    );
  });
});
