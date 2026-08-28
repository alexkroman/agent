// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-storage` — enforcement, as opposed to the decision.
 *
 * `workflow-storage-scope.test.ts` asserts that every method HAS a scope and that a
 * missing run id is refused. These assert what the scopes DO, and the ones worth
 * reading are the four that are not "check a run id": a `runs.list` that must not
 * forward, a correlation-id lookup that must filter, a hook lookup that must
 * resolve-then-check, and a create that must claim.
 *
 * The world is FAKED here, deliberately. Every assertion is about what the platform
 * asks it and what it does with the answer — and a fake is the only way to hand
 * back another tenant's row on purpose, which is the case that matters most.
 */

import { createPlatformStorage } from "@alexkroman1/aai-runtime/internal";
import { describe, expect, test } from "vitest";
import {
  bearerFor,
  callStorage,
  deploy,
  fakeWorld,
  MINE,
  platform,
  THEIRS,
} from "./_workflow-storage-test-utils.ts";
import { captureLogs, createTestOrchestrator, fakeAdminDbOver } from "./test-utils.ts";

describe("POST /:slug/workflow-storage", () => {
  const logs = captureLogs();

  describe("authorization", () => {
    test("accepts the bearer this agent's guest holds", async () => {
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "runs.get", args: ["run_mine"] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
    });

    test.each([
      ["no bearer", undefined],
      ["a guessed token", "0".repeat(64)],
    ])("refuses %s", async (_label, bearer) => {
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "runs.get", args: ["run_mine"] },
        bearer,
      );
      expect(res.status).toBe(401);
      expect(p.world.calls).toEqual([]);
    });

    test("refuses another agent's guest holding a valid token of its own", async () => {
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "runs.get", args: ["run_mine"] },
        await bearerFor(p.store, THEIRS),
      );
      expect(res.status).toBe(401);
      expect(p.world.calls).toEqual([]);
    });
  });

  describe("the run-keyed methods", () => {
    test("forwards a call for a run this agent owns", async () => {
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.list", args: [{ runId: "run_mine" }] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
      expect(p.world.calls.map((c) => c.method)).toEqual(["events.list"]);
    });

    /**
     * The core assertion of this route: a run another agent owns is a 404, and the
     * world is never asked.
     *
     * 404 rather than 403 — "not yours" and "does not exist" have to be the same
     * answer, or the reply confirms that a run id exists.
     */
    test("answers 404 for a run another agent owns, without asking the world", async () => {
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "runs.get", args: ["run_theirs"] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(404);
      expect(p.world.calls).toEqual([]);
    });

    test("answers the SAME 404 for a run that does not exist", async () => {
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "runs.get", args: ["run_absent"] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "no such run" });
    });

    test("answers 400 when a required run id is missing, and asks nothing", async () => {
      // `steps.get`'s first parameter is optional in their signature; undefined
      // would look a step up by id alone.
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "steps.get", args: [null, "step_1"] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(400);
      expect(p.world.calls).toEqual([]);
    });
  });

  describe("runs.list, which is never forwarded", () => {
    /**
     * Their list query filters on `workflowName` and `status` with no run key, so
     * forwarding it would return every agent's runs. This answers from the
     * ownership table and `runs.get` instead.
     */
    test("reads this agent's own run ids rather than calling their list", async () => {
      const world = fakeWorld({
        "runs.get": { id: "run_mine", workflowName: "w", status: "running" },
      });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "runs.list", args: [{}] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
      // The tell: their `runs.list` was NOT called.
      expect(world.calls.map((c) => c.method)).not.toContain("runs.list");
      expect(world.calls.map((c) => c.method)).toContain("runs.get");
    });

    test("answers their own paginated shape, so the client needs no special case", async () => {
      const world = fakeWorld({ "runs.get": { id: "run_mine", status: "running" } });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "runs.list", args: [{}] },
        await bearerFor(p.store, MINE),
      );
      const body = (await res.json()) as { result: { data: unknown[]; pagination: unknown } };
      expect(Array.isArray(body.result.data)).toBe(true);
      expect(body.result.pagination).toEqual({ hasMore: false });
    });

    test("applies the caller's status filter itself", async () => {
      const world = fakeWorld({ "runs.get": { id: "run_mine", status: "completed" } });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "runs.list", args: [{ status: "running" }] },
        await bearerFor(p.store, MINE),
      );
      const body = (await res.json()) as { result: { data: unknown[] } };
      expect(body.result.data).toEqual([]);
    });

    /**
     * More runs than one page, so the filter has to be applied to a SCAN.
     *
     * The fixtures above own ONE run each, which is why the case below went
     * unnoticed: with a single id there is no second page for a filter to miss.
     * This responder honours `limit`/`offset` the way the real table does.
     */
    async function paged(statusOf: (id: string) => string, count = 60) {
      const all = Array.from({ length: count }, (_, i) => `run_${String(i).padStart(3, "0")}`);
      const adminDb = fakeAdminDbOver((sql, params) => {
        if (sql.includes("select slug from aai_platform.workflow_run_owner")) {
          return [{ slug: MINE }];
        }
        if (sql.includes("select run_id from aai_platform.workflow_run_owner")) {
          const limit = Number(params?.[1] ?? 0);
          const offset = Number(params?.[2] ?? 0);
          return all.slice(offset, offset + limit).map((run_id) => ({ run_id }));
        }
        return [];
      });
      const runStorage = {
        runs: {
          get: (id: string) => Promise.resolve({ id, status: statusOf(id) }),
          list: () => Promise.reject(new Error("runs.list must never be forwarded")),
        },
        steps: {},
        events: {},
        hooks: {},
        streamer: {},
        close: () => Promise.resolve(),
      };
      const harness = await createTestOrchestrator({ adminDb, runStorage });
      await deploy(harness.fetch, MINE);
      return harness;
    }

    test("finds matches BEYOND the first page rather than reporting none", async () => {
      // The newest 50 are all running and the completed ones sit behind them.
      // Filtering a single truncated page answered `{ data: [], hasMore: false }`
      // — an empty list plus an assurance there was nothing more to fetch —
      // while ten completed runs existed one page back.
      const h = await paged((id) => (id >= "run_050" ? "completed" : "running"));
      const res = await callStorage(
        h.fetch,
        MINE,
        { method: "runs.list", args: [{ status: "completed", pagination: { limit: 10 } }] },
        await bearerFor(h.store, MINE),
      );
      const body = (await res.json()) as {
        result: { data: { id: string }[]; pagination: { hasMore: boolean } };
      };
      expect(body.result.data).toHaveLength(10);
      expect(body.result.data.map((r) => r.id)).toContain("run_050");
      // The walk reached the end of this agent's runs, so there is genuinely
      // nothing further — which is a claim the old `hasMore: false` was making
      // without having looked.
      expect(body.result.pagination.hasMore).toBe(false);
    });

    test("reports hasMore when a full page leaves runs behind it", async () => {
      const h = await paged(() => "running");
      const res = await callStorage(
        h.fetch,
        MINE,
        { method: "runs.list", args: [{ pagination: { limit: 10 } }] },
        await bearerFor(h.store, MINE),
      );
      const body = (await res.json()) as {
        result: { data: unknown[]; pagination: { hasMore: boolean } };
      };
      expect(body.result.data).toHaveLength(10);
      expect(body.result.pagination.hasMore).toBe(true);
    });

    test("stops walking rather than reading every run of a huge agent", async () => {
      // A filter matching nothing costs one `runs.get` per id scanned, so the
      // walk is bounded (MAX_RUN_SCAN). Hitting the bound answers hasMore, which
      // is the truthful answer: it stopped early.
      const reads: string[] = [];
      const h = await paged((id) => {
        reads.push(id);
        return "running";
      }, 100_000);
      const res = await callStorage(
        h.fetch,
        MINE,
        { method: "runs.list", args: [{ status: "completed", pagination: { limit: 10 } }] },
        await bearerFor(h.store, MINE),
      );
      const body = (await res.json()) as {
        result: { data: unknown[]; pagination: { hasMore: boolean } };
      };
      expect(body.result.data).toEqual([]);
      expect(body.result.pagination.hasMore).toBe(true);
      expect(reads.length).toBeLessThan(2500);
    });
  });

  describe("events.listByCorrelationId, which is filtered", () => {
    /**
     * A correlation id is chosen by the AUTHOR, so two agents may legitimately use
     * the same one — it cannot be required to belong to this agent. So the results
     * are filtered by the run each event belongs to.
     */
    test("drops events belonging to another agent's run", async () => {
      const world = fakeWorld({
        "events.listByCorrelationId": {
          data: [
            { runId: "run_mine", id: "e1" },
            { runId: "run_theirs", id: "e2" },
          ],
          pagination: { hasMore: false },
        },
      });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.listByCorrelationId", args: [{ correlationId: "c1" }] },
        await bearerFor(p.store, MINE),
      );
      const body = (await res.json()) as { result: { data: { id: string }[] } };
      // One request, two runs, one of them another agent's — and only this
      // agent's event comes back.
      expect(body.result.data.map((e) => e.id)).toEqual(["e1"]);
    });

    test("drops an event with no readable run id", async () => {
      // A value this code cannot attribute is one it must not return.
      const world = fakeWorld({
        "events.listByCorrelationId": { data: [{ payload: "orphan" }], pagination: {} },
      });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.listByCorrelationId", args: [{ correlationId: "c1" }] },
        await bearerFor(p.store, MINE),
      );
      const body = (await res.json()) as { result: { data: unknown[] } };
      expect(body.result.data).toEqual([]);
    });
  });

  describe("hooks, which are resolved then checked", () => {
    test("returns a hook whose run this agent owns", async () => {
      const world = fakeWorld({ "hooks.getByToken": { id: "h1", runId: "run_mine" } });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "hooks.getByToken", args: ["tok"] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
    });

    /**
     * A token is not a way to learn about another agent's run.
     *
     * The world IS called here — it has to be, to learn which run the hook belongs
     * to — so what matters is that the answer does not come back.
     */
    test("answers 404 for a hook on another agent's run, and does not return it", async () => {
      const world = fakeWorld({ "hooks.get": { id: "h1", runId: "run_theirs" } });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "hooks.get", args: ["h1"] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("run_theirs");
    });

    test("answers 404 for a hook with no run id at all", async () => {
      const world = fakeWorld({ "hooks.get": { id: "h1" } });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "hooks.get", args: ["h1"] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("events.create, the one mutation", () => {
    test("claims a client-supplied run id BEFORE writing the event", async () => {
      // Claiming afterwards would leave a window in which the run exists and is
      // unowned, and a crash inside it leaves a run nobody can read.
      const order: string[] = [];
      const world = fakeWorld();
      const adminDb = fakeAdminDbOver((sql) => {
        if (sql.includes("insert into aai_platform.workflow_run_owner")) {
          order.push("claim");
          return [{ slug: MINE }];
        }
        return [];
      });
      const harness = await createTestOrchestrator({ adminDb, runStorage: world });
      await deploy(harness.fetch, MINE);
      const res = await callStorage(
        harness.fetch,
        MINE,
        { method: "events.create", args: ["run_new", { type: "run_created" }] },
        await bearerFor(harness.store, MINE),
      );
      expect(res.status).toBe(200);
      order.push(...world.calls.map((c) => c.method));
      expect(order).toEqual(["claim", "events.create"]);
    });

    test("claims a server-generated run id from the reply", async () => {
      const world = fakeWorld({ "events.create": { run: { id: "run_gen" }, event: { id: "e1" } } });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.create", args: [null, { type: "run_created" }] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
      expect(world.calls.map((c) => c.method)).toEqual(["events.create"]);
    });

    test("refuses to answer when a run was created and cannot be attributed", async () => {
      // Returning it would hand back a run no ownership row covers — unreadable
      // afterwards and never reaped.
      const world = fakeWorld({ "events.create": { event: { id: "e1" } } });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.create", args: [null, { type: "run_created" }] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(502);
      expect(logs.warns().join(" ")).toContain("no run id");
    });

    test("an event on an EXISTING run is checked like a read", async () => {
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.create", args: ["run_theirs", { type: "step_started" }] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(404);
      expect(p.world.calls).toEqual([]);
    });
  });

  describe("the request itself", () => {
    test.each([
      ["an unknown method", { method: "runs.destroy", args: [] }],
      ["a missing method", { args: [] }],
      ["args that are not an array", { method: "runs.get", args: "run_1" }],
      ["a body that is not an object", '"a string"'],
    ])("answers 400 for %s", async (_label, body) => {
      const p = await platform();
      const res = await callStorage(p.fetch, MINE, body, await bearerFor(p.store, MINE));
      expect(res.status).toBe(400);
      expect(p.world.calls).toEqual([]);
    });

    test("does not echo the caller's method name back", async () => {
      // The reply is a tenant's to read, and reflecting input is how a route becomes
      // a mirror for whatever a caller wants to see.
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "<script>alert(1)</script>", args: [] },
        await bearerFor(p.store, MINE),
      );
      expect(await res.text()).not.toContain("script");
    });
  });

  describe("when there is no run storage", () => {
    test("answers 501, because a retry will not make one", async () => {
      const harness = await createTestOrchestrator();
      await deploy(harness.fetch, MINE);
      const res = await callStorage(
        harness.fetch,
        MINE,
        { method: "runs.get", args: ["run_mine"] },
        await bearerFor(harness.store, MINE),
      );
      expect(res.status).toBe(501);
    });
  });

  test("a method their world does not expose answers 501, not 500", async () => {
    // Their shape moved: the member is gone.
    const p = await platform(fakeWorld({}, ["hooks.list"]));
    const res = await callStorage(
      p.fetch,
      MINE,
      { method: "hooks.list", args: [{ runId: "run_mine" }] },
      await bearerFor(p.store, MINE),
    );
    expect(res.status).toBe(501);
  });

  /**
   * THE WIRE, end to end: the guest's own client against this route.
   *
   * Every spec above builds a request by hand, which is exactly how the two sides
   * come to disagree about the encoding. This one uses `createPlatformStorage` —
   * the real client — so the codec, the method names and the reply shape are all
   * checked against the thing that will actually call this.
   *
   * The binary is the point. A run's input is a `Uint8Array`, and plain JSON turns
   * it into an index map with no error anywhere: the world would be handed
   * `{"0":7}` where it expects bytes, and the first sign of it would be devalue
   * failing inside a replay.
   */
  describe("against the guest's real client", () => {
    test("carries binary to the world and back, unchanged", async () => {
      const input = new Uint8Array([7, 0, 255]);
      const world = fakeWorld({
        "runs.get": { runId: "run_mine", output: Buffer.from([1, 2]) },
        "events.create": { run: { id: "run_mine" }, event: { id: "e1" } },
      });
      const p = await platform(world);
      const storage = createPlatformStorage({
        base: `http://platform.test/${MINE}`,
        token: await bearerFor(p.store, MINE),
        fetch: async (i, init) => {
          const req = new Request(i, init);
          return p.fetch(new URL(req.url).pathname, {
            method: req.method,
            headers: req.headers,
            body: await req.text(),
          });
        },
      });

      // Guest → platform → world. `fakeWorld` records the arguments it was handed,
      // which is the half a hand-built request cannot check: what the WORLD saw.
      await storage.events.create("run_mine", { type: "step_started", input });
      const created = world.calls.find((c) => c.method === "events.create");
      const seen = created?.args[1] as { input: unknown };
      expect(seen.input).toBeInstanceOf(Uint8Array);
      expect(seen.input).toEqual(input);

      // World → platform → guest. The world answers a `Buffer` (which is what a
      // `bytea` column reads back as), and the guest must receive bytes.
      const run = (await storage.runs.get("run_mine")) as { output: unknown };
      expect(run.output).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(run.output as Uint8Array)).toEqual(Buffer.from([1, 2]));
    });

    test("a run another agent owns rejects with the platform's 404", async () => {
      const p = await platform();
      const storage = createPlatformStorage({
        base: `http://platform.test/${MINE}`,
        token: await bearerFor(p.store, MINE),
        fetch: async (i, init) => {
          const req = new Request(i, init);
          return p.fetch(new URL(req.url).pathname, {
            method: req.method,
            headers: req.headers,
            body: await req.text(),
          });
        },
      });
      await expect(storage.runs.get("run_theirs")).rejects.toThrow(/HTTP 404/);
    });
  });
});
