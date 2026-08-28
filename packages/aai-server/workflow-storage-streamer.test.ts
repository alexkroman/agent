// Copyright 2026 the AAI authors. MIT license.
/**
 * The Streamer half of the run-storage route, and why its names are namespaced.
 *
 * `@workflow/world-postgres`'s `readFromStream` looks a stream up by NAME ALONE
 * (`where(eq(streams.streamId, name))`, no run filter) and its live fan-out keys on
 * `strm:${name}` the same way. With every agent's streams in one schema, two agents
 * that pick the same name share a stream — and no check at this layer closes that,
 * because their query cannot tell the two apart.
 *
 * So the platform qualifies the name on the way in and strips it on the way out.
 * These are the specs for that, plus the assertion that the run check the Storage
 * methods get applies here too.
 *
 * Its own file rather than a section of `workflow-storage-handler.test.ts`: that one
 * reached its length cap, and the two are split by SUBJECT — their Storage there,
 * their Streamer here — with the fixtures shared rather than copied.
 */

import { describe, expect, test } from "vitest";
import { callStorage, fakeWorld, MINE, platform, THEIRS } from "./_workflow-storage-test-utils.ts";
import { bearerFor } from "./test-utils.ts";

describe("POST /:slug/workflow-storage — the streamer", () => {
  /**
   * The reason the namespacing exists.
   *
   * Their `readFromStream` looks a stream up by NAME ALONE, with no run filter,
   * and their live fan-out keys on `strm:${name}`. So two agents that pick the
   * same name would share a stream, and no check here could close that. The name
   * is qualified on the way in instead.
   */
  test("qualifies the stream name before the world sees it", async () => {
    const p = await platform();
    const res = await callStorage(
      p.fetch,
      MINE,
      { method: "streamer.writeToStream", args: ["output", "run_mine", "chunk"] },
      await bearerFor(p.store, MINE),
    );
    expect(res.status).toBe(200);
    const call = p.world.calls.find((c) => c.method === "streamer.writeToStream");
    expect(call?.args[0]).toBe(`${MINE}/output`);
    // Everything else is forwarded untouched.
    expect(call?.args[1]).toBe("run_mine");
    expect(call?.args[2]).toBe("chunk");
  });

  test("two agents writing the same NAME reach different streams", async () => {
    const p = await platform();
    await callStorage(
      p.fetch,
      MINE,
      { method: "streamer.writeToStream", args: ["output", "run_mine", "a"] },
      await bearerFor(p.store, MINE),
    );
    await callStorage(
      p.fetch,
      THEIRS,
      { method: "streamer.writeToStream", args: ["output", "run_theirs", "b"] },
      await bearerFor(p.store, THEIRS),
    );
    const names = p.world.calls
      .filter((c) => c.method === "streamer.writeToStream")
      .map((c) => c.args[0]);
    expect(names).toEqual([`${MINE}/output`, `${THEIRS}/output`]);
    expect(new Set(names).size).toBe(2);
  });

  test.each([
    "streamer.writeToStream",
    "streamer.closeStream",
    "streamer.getStreamChunks",
    "streamer.getStreamInfo",
  ])("%s still refuses a run this agent does not own", async (method) => {
    const p = await platform();
    const res = await callStorage(
      p.fetch,
      MINE,
      { method, args: ["output", "run_theirs"] },
      await bearerFor(p.store, MINE),
    );
    expect(res.status).toBe(404);
    expect(p.world.calls).toEqual([]);
  });

  test("refuses a call with no stream name, rather than qualifying undefined", async () => {
    const p = await platform();
    const res = await callStorage(
      p.fetch,
      MINE,
      { method: "streamer.writeToStream", args: [null, "run_mine", "chunk"] },
      await bearerFor(p.store, MINE),
    );
    expect(res.status).toBe(400);
    expect(p.world.calls).toEqual([]);
  });

  test("strips the namespace off the names it LISTS", async () => {
    // The one method that returns names. Without the strip, a caller would get
    // back keys it never wrote and could not use.
    const world = fakeWorld({
      "streamer.listStreamsByRunId": [`${MINE}/output`, `${MINE}/nested/path`],
    });
    const p = await platform(world);
    const res = await callStorage(
      p.fetch,
      MINE,
      { method: "streamer.listStreamsByRunId", args: ["run_mine"] },
      await bearerFor(p.store, MINE),
    );
    const body = (await res.json()) as { result: string[] };
    expect(body.result).toEqual(["output", "nested/path"]);
  });

  test("DROPS a listed name belonging to another agent", async () => {
    // Unreachable if the invariants hold — the run was checked and every stream
    // of it was written through the qualifier — so a foreign name means something
    // broke, and handing back a value this code cannot attribute is the wrong way
    // to learn that.
    const world = fakeWorld({
      "streamer.listStreamsByRunId": [`${MINE}/mine`, `${THEIRS}/theirs`, "unqualified"],
    });
    const p = await platform(world);
    const res = await callStorage(
      p.fetch,
      MINE,
      { method: "streamer.listStreamsByRunId", args: ["run_mine"] },
      await bearerFor(p.store, MINE),
    );
    const body = (await res.json()) as { result: string[] };
    expect(body.result).toEqual(["mine"]);
  });
});
