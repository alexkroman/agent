// Copyright 2026 the AAI authors. MIT license.
/**
 * What each SCOPE does — the enforcement in `workflow-storage-apply.ts`.
 *
 * Split from `workflow-storage-handler.test.ts` when that file passed its length
 * cap, along the same seam as the source: that suite covers the HTTP surface (the
 * bearer, the body codec, the status taxonomy, the real guest client), and this
 * one covers the four rules that are not "check a run id" — a `runs.list` that
 * must not forward, a correlation-id lookup that must filter, a hook lookup that
 * must resolve-then-check, and a create that must claim.
 *
 * The world is FAKED here, deliberately. Every assertion is about what the platform
 * asks it and what it does with the answer — and a fake is the only way to hand
 * back another tenant's row on purpose, which is the case that matters most.
 */

import { describe, expect, test } from "vitest";
import {
  bearerFor,
  callStorage,
  deploy,
  fakeWorld,
  MINE,
  ownershipResponder,
  platform,
  THEIRS,
} from "./_workflow-storage-test-utils.ts";
import { captureLogs, createTestOrchestrator, fakeAdminDbOver } from "./test-utils.ts";

describe("storage scopes", () => {
  const logs = captureLogs();

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
     * A correlation id is the DevKit's own generated ULID (`step_<ulid>` and
     * friends) — NOT author-chosen; `HookOptions` has a `token` and no
     * `correlationId`. It is still a shared namespace with no tenant column and
     * this surface has no run id to scope it by, so the results are filtered by
     * the run each event belongs to.
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

    /**
     * `cursor` and `hasMore` are computed by the DevKit from the UNFILTERED page
     * (`storage.js`: `cursor: values.at(-1)?.eventId`, `hasMore: all.length >
     * limit`), so spreading the reply and replacing only `data` handed back
     * another tenant's event id and a truthy `hasMore` for a correlation id that
     * is not ours — an existence oracle beside a `data: []` that correctly said
     * nothing. The module's own rule is that a value this code cannot attribute
     * must not be returned, and a cursor derived from foreign rows is such a value.
     */
    test("does not return a cursor derived from another agent's rows", async () => {
      const world = fakeWorld({
        "events.listByCorrelationId": {
          data: [
            { runId: "run_mine", id: "e1" },
            { runId: "run_theirs", id: "e2" },
          ],
          cursor: "wevt_theirs_01JABCDEF",
          hasMore: true,
        },
      });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.listByCorrelationId", args: [{ correlationId: "step_01JXYZ" }] },
        await bearerFor(p.store, MINE),
      );
      const body = (await res.json()) as {
        result: { data: { id: string }[]; cursor: unknown; hasMore: unknown };
      };
      expect(body.result.data.map((e) => e.id)).toEqual(["e1"]);
      expect(body.result.cursor).toBeNull();
      expect(body.result.hasMore).toBe(false);
      expect(JSON.stringify(body)).not.toContain("wevt_theirs");
    });

    test("keeps the page's own cursor when nothing was dropped", async () => {
      // Filtering nothing means the page is wholly this agent's, so its cursor and
      // `hasMore` describe exactly what is being returned — refusing to paginate
      // there would break the ordinary case to fix the leaking one.
      const world = fakeWorld({
        "events.listByCorrelationId": {
          data: [{ runId: "run_mine", id: "e1" }],
          cursor: "wevt_mine_01JABC",
          hasMore: true,
        },
      });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.listByCorrelationId", args: [{ correlationId: "step_01JXYZ" }] },
        await bearerFor(p.store, MINE),
      );
      const body = (await res.json()) as { result: { cursor: unknown; hasMore: unknown } };
      expect(body.result.cursor).toBe("wevt_mine_01JABC");
      expect(body.result.hasMore).toBe(true);
    });

    test("fails CLOSED on a reply it cannot read as a page", async () => {
      // A reply this code cannot filter is one it must not forward. Unreachable on
      // the pinned world-postgres, which always answers `{data, cursor, hasMore}`
      // — which is exactly why it must not be a silent pass-through: the whole
      // point is the version where that stops being true.
      const world = fakeWorld({ "events.listByCorrelationId": { items: ["surprise"] } });
      const p = await platform(world);
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.listByCorrelationId", args: [{ correlationId: "step_01JXYZ" }] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain("surprise");
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
        { method: "events.create", args: ["run_new", { eventType: "run_created" }] },
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
        { method: "events.create", args: [null, { eventType: "run_created" }] },
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
        { method: "events.create", args: [null, { eventType: "run_created" }] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(502);
      expect(logs.warns().join(" ")).toContain("no run id");
    });

    /**
     * The DevKit discriminates on `eventType`. `CreateEventSchema`
     * (`@workflow/world`) is a discriminated union on that field and declares no
     * `type` member at all, and it is `$strip`, so an undeclared `type` key is
     * accepted and dropped.
     *
     * Reading the wrong field here was a tenant-scoping bypass AND an outage, and
     * the tests in this block were written against the handler's own mistaken
     * assumption — every payload above said `{ type: ... }`, so they agreed with
     * the bug and could not see either half. They say `eventType` now.
     */
    test("a caller-supplied `type` key does not select the claim branch", async () => {
      // `events.create` is the only mutation here and `decideScope` exempts it
      // from the shared `ownsRun` gate, so this branch IS the authorization
      // decision. Selecting it with a field the DevKit never sends made that
      // decision the caller's to make.
      //
      // The assertion is that no CLAIM was attempted, not merely that the answer
      // was 404: `claimNewRun` now refuses a foreign or orphaned run, so a status
      // check alone passes with the wrong discriminator still in place and proves
      // only that the layer underneath held. What must be true is that a stray
      // `type` key never reaches the claim path at all.
      const statements: string[] = [];
      const world = fakeWorld();
      const adminDb = fakeAdminDbOver((sql) => {
        statements.push(sql);
        if (sql.includes("select slug from aai_platform.workflow_run_owner")) {
          return [{ slug: THEIRS }];
        }
        return [];
      });
      const harness = await createTestOrchestrator({ adminDb, runStorage: world });
      await deploy(harness.fetch, MINE);
      const res = await callStorage(
        harness.fetch,
        MINE,
        {
          method: "events.create",
          args: ["run_theirs", { type: "run_created", eventType: "run_cancelled" }],
        },
        await bearerFor(harness.store, MINE),
      );
      expect(res.status).toBe(404);
      expect(
        statements.some((s) => s.includes("insert into aai_platform.workflow_run_owner")),
      ).toBe(false);
      // And it must not have reached the world at all.
      expect(world.calls).toEqual([]);
    });

    test("a run owned by another agent answers 404, never a 5xx", async () => {
      // `claimRun` throws, and a bare Error reaches the shared handler as a 5xx —
      // which reads as "retry me" for a decision no retry changes, and tells the
      // caller its guessed run id names something real. Same answer as every other
      // way this surface says "not yours".
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.create", args: ["run_theirs", { eventType: "run_created" }] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("owned by another");
    });

    test("an ORPHANED run — one that exists with no owner — cannot be adopted", async () => {
      // `workflow_run_owner.slug` cascades on agent delete while the DevKit's
      // `workflow.*` rows deliberately survive, so a deleted agent leaves runs that
      // exist and are owned by nobody. Treating an absent ownership row as "free"
      // handed those to whoever named the id, which would unlock the previous
      // tenant's step arguments, results, event journal and hook tokens.
      //
      // The responder models the real statement: its `not exists` suppresses the
      // insert when the run is already in `workflow.workflow_runs`, so nothing is
      // returned and no ownership row is found afterwards.
      const world = fakeWorld();
      const adminDb = fakeAdminDbOver((sql) => {
        if (sql.includes("insert into aai_platform.workflow_run_owner")) return [];
        if (sql.includes("select slug from aai_platform.workflow_run_owner")) return [];
        return [];
      });
      const harness = await createTestOrchestrator({ adminDb, runStorage: world });
      await deploy(harness.fetch, MINE);
      const res = await callStorage(
        harness.fetch,
        MINE,
        { method: "events.create", args: ["run_orphan", { eventType: "run_created" }] },
        await bearerFor(harness.store, MINE),
      );
      expect(res.status).toBe(404);
      expect(world.calls).toEqual([]);
      expect(logs.warns().join(" ")).toContain("orphaned run");
    });

    test("an event on an EXISTING run is checked like a read", async () => {
      const p = await platform();
      const res = await callStorage(
        p.fetch,
        MINE,
        { method: "events.create", args: ["run_theirs", { eventType: "step_started" }] },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(404);
      expect(p.world.calls).toEqual([]);
    });
  });

  /**
   * The EGRESS check — the one assertion that does not care which scope ran.
   *
   * Every inbound mechanism answers "was this call classified and checked". None
   * of them answers "is what I am about to send back actually theirs" — so a
   * filter that stops filtering, a resolve-then-check that stops checking, or a
   * wrong `index` in `STORAGE_SCOPES` is caught here and nowhere else.
   *
   * It would NOT have caught the `scopeCreate` bug, and the module doc says so:
   * that one wrongly established ownership on the way in, so the reply was
   * genuinely the caller's by the time it came back. `claimNewRun` covers that
   * half. These are complements.
   */
  describe("nothing foreign leaves, whatever the scope did", () => {
    /** A well-formed run id, since the grammar signal is half the check. */
    const FOREIGN_RUN = "wrun_01JQZX9WM4T7YBVK3H2NRDFCPE";

    async function leaking(answer: unknown) {
      // This agent owns `run_mine` and nothing else — so the inbound check on
      // `run_mine` passes and the reply is still not ours.
      const world = fakeWorld({ "runs.get": answer });
      const adminDb = fakeAdminDbOver(ownershipResponder({ run_mine: MINE }));
      const harness = await createTestOrchestrator({ adminDb, runStorage: world });
      await deploy(harness.fetch, MINE);
      return callStorage(
        harness.fetch,
        MINE,
        { method: "runs.get", args: ["run_mine"] },
        await bearerFor(harness.store, MINE),
      );
    }

    test("catches a foreign run id under a runId key", async () => {
      // The KEY signal: survives the id format changing.
      const res = await leaking({ runId: FOREIGN_RUN, output: "someone else's" });
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain("someone else's");
      expect(logs.errors().join(" ")).toContain("does not own");
    });

    test("catches a foreign run id by its GRAMMAR, under any key", async () => {
      // The other signal: survives the KEY changing. A run entity's own primary
      // key is a bare `id` — the DevKit spreads its row — and a step, event and
      // hook all have an `id` too, so the id itself has to be recognisable.
      const res = await leaking({ id: FOREIGN_RUN, status: "completed" });
      expect(res.status).toBe(502);
    });

    test("finds one nested inside an arbitrary reply", async () => {
      const res = await leaking({ page: { items: [{ meta: { runId: FOREIGN_RUN } }] } });
      expect(res.status).toBe(502);
    });

    test("lets this agent's OWN run through", async () => {
      // The check must not be a blanket refusal — a reply naming the run the
      // caller legitimately asked for is the ordinary case.
      const res = await leaking({ runId: "run_mine", id: "run_mine", output: "ours" });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("ours");
    });

    test("ignores a reply that names no run at all", async () => {
      // No ids means no query — the common path must not pay for this.
      const res = await leaking({ ok: true, chunks: [1, 2, 3] });
      expect(res.status).toBe(200);
    });
  });
});
