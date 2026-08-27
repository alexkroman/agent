// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the composition.
 *
 * One property here fails SILENTLY, which is why it gets its own spec: if the
 * composed world inherits the base world's `start`, graphile-worker subscribes
 * anyway and the whole change is undone with no symptom but connection pressure —
 * nothing errors, no run misbehaves, and the only evidence is a number on a
 * Postgres instance. A spread is the natural way to write this and the wrong one.
 */

import { describe, expect, test, vi } from "vitest";
import {
  composePlatformWorld,
  describePlatformQueueGap,
  resolvePlatformQueue,
} from "./workflow-platform-world.ts";

const BASE = "https://api.test/my-agent";
const TOKEN = "sandbox-bearer";

/** A stand-in for the Postgres world: the members the composition touches. */
function baseWorld() {
  return {
    specVersion: 3,
    queue: vi.fn(async () => ({ messageId: "graphile-1" })),
    // What must NOT run: the real one subscribes graphile-worker.
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createQueueHandler: vi.fn(),
    runs: { get: vi.fn() },
    events: { create: vi.fn() },
  };
}

describe("resolvePlatformQueue", () => {
  test("reads the pair the platform bakes into a deployed guest", () => {
    expect(resolvePlatformQueue({ AAI_PUBLIC_BASE_URL: BASE, AAI_GUEST_TOKEN: TOKEN })).toEqual({
      base: BASE,
      token: TOKEN,
    });
  });

  test.each([
    ["neither, which is `aai dev` and every self-hosted server", {}],
    ["only the base", { AAI_PUBLIC_BASE_URL: BASE }],
    ["only the token", { AAI_GUEST_TOKEN: TOKEN }],
    ["blank values", { AAI_PUBLIC_BASE_URL: "  ", AAI_GUEST_TOKEN: "  " }],
  ])("declines %s", (_label, env) => {
    expect(resolvePlatformQueue(env)).toBeUndefined();
  });
});

describe("describePlatformQueueGap", () => {
  // A HALF-configured environment means the platform spawns guests differently
  // than this code expects. Falling back silently to the in-guest queue would hide
  // that behind a connection bill nobody reads, so the caller reports it.
  test.each([
    [{ AAI_PUBLIC_BASE_URL: BASE }, /AAI_PUBLIC_BASE_URL is set but AAI_GUEST_TOKEN/],
    [{ AAI_GUEST_TOKEN: TOKEN }, /AAI_GUEST_TOKEN is set but AAI_PUBLIC_BASE_URL/],
  ])("names which half is missing for %o", (env, expected) => {
    expect(describePlatformQueueGap(env)).toMatch(expected);
  });

  test.each([
    ["both present", { AAI_PUBLIC_BASE_URL: BASE, AAI_GUEST_TOKEN: TOKEN }],
    ["neither present", {}],
  ])("says nothing when the environment is coherent (%s)", (_label, env) => {
    expect(describePlatformQueueGap(env)).toBeUndefined();
  });
});

describe("composePlatformWorld", () => {
  const composed = () => composePlatformWorld(baseWorld(), { base: BASE, token: TOKEN });

  /**
   * The silent one.
   *
   * `world.start()` is what takes a connection out of the world's pool and holds
   * it for the process's life to `LISTEN` for `jobs:insert`, then runs a worker
   * pool beside it. A spread that inherited it would give back nothing while
   * every test still passed.
   */
  test("does NOT inherit the base world's start, which subscribes graphile-worker", async () => {
    const base = baseWorld();
    const world = composePlatformWorld(base, { base: BASE, token: TOKEN });
    await world.start?.();
    expect(base.start).not.toHaveBeenCalled();
  });

  test("replaces the queue, so no message reaches graphile-worker", async () => {
    const base = baseWorld();
    const world = composePlatformWorld(base, { base: BASE, token: TOKEN });
    expect(world.queue).not.toBe(base.queue);
    // It fails without a reachable platform, which is the correct failure — the
    // point is that the BASE queue was not the thing called.
    await Promise.resolve(
      (world.queue as (n: string, m: unknown) => Promise<unknown>)("__wkf_step_r1", {
        runId: "r1",
      }),
    ).catch(() => undefined);
    expect(base.queue).not.toHaveBeenCalled();
  });

  /**
   * Everything else is the DevKit's, and keeping it is the whole design.
   *
   * `createQueueHandler` especially: it is a pure request→handler adapter, it is
   * what the guest's loaded route modules already bound, and reimplementing it
   * would mean owning the queue↔executor contract on both sides.
   */
  test.each(["specVersion", "close", "createQueueHandler", "runs", "events"])(
    "keeps the base world's %s untouched",
    (key) => {
      const base = baseWorld();
      const world = composePlatformWorld(base, { base: BASE, token: TOKEN }) as Record<
        string,
        unknown
      >;
      expect(world[key]).toBe((base as Record<string, unknown>)[key]);
    },
  );

  test("leaves the base world object unmutated", async () => {
    // A composition that assigned onto the base would make the override visible to
    // anything holding the original — including the DevKit's own caches, which
    // `setWorld` is supposed to be the only writer of.
    const base = baseWorld();
    const originalQueue = base.queue;
    composePlatformWorld(base, { base: BASE, token: TOKEN });
    expect(base.queue).toBe(originalQueue);
    expect(base.start).not.toHaveBeenCalled();
  });

  test("its start resolves rather than throwing, since the caller awaits it", async () => {
    await expect(composed().start?.()).resolves.toBeUndefined();
  });
});
