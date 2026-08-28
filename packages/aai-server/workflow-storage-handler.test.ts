// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-storage` — enforcement, as opposed to the decision.
 *
 * The HTTP surface: the bearer, the shared run-keyed gate, the request taxonomy,
 * the not-configured and shape-moved answers, and the real guest client over the
 * wire. What each SCOPE does is `workflow-storage-apply.test.ts`, split from here
 * along the same seam as the source; `workflow-storage-scope.test.ts` asserts that
 * every method HAS a scope and that a missing run id is refused.
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
import { createTestOrchestrator } from "./test-utils.ts";

describe("POST /:slug/workflow-storage", () => {
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
      await storage.events.create("run_mine", { eventType: "step_started", input });
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
