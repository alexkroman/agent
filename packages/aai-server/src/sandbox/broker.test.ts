// Copyright 2026 the AAI authors. MIT license.
/**
 * The broker's failure taxonomy, over a RESIDENT fake sandbox so nothing spawns.
 * The cold path's spawn and drain interleavings are in `resolve.test.ts`.
 */

import { HTTPException } from "hono/http-exception";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { captureLogs } from "../_logger-test-utils.ts";
import { createTestOrchestrator } from "../_orchestrator-test-utils.ts";
import { deployAgent } from "../_request-test-utils.ts";
import { fakeSandbox } from "../_sandbox-test-utils.ts";
import type { Sandbox } from "../sandbox.ts";
import {
  AGENT_UNAVAILABLE_MESSAGE,
  brokerSessionUrl,
  brokerSessionUrlOrThrow,
  notFoundMessage,
} from "./broker.ts";
import { createMemorySandboxDirectory, SandboxNameTakenError } from "./directory.ts";
import type { ResolveSandboxOpts } from "./resolve.ts";
import { createSlotCache, setSlot } from "./slots.ts";

const PEER = { sessionUrl: "wss://peer.test/websocket", guestOrigin: "wss://peer.test" };

/** A deployed `slug` whose resident is `sandbox`, built at the deploy's version. */
async function resident(
  slug: string,
  sandbox: (version: number) => Sandbox,
  extra: Partial<ResolveSandboxOpts> = {},
): Promise<ResolveSandboxOpts & { version: number }> {
  const slots = createSlotCache();
  const { fetch, store } = await createTestOrchestrator({ slots });
  await deployAgent(fetch, slug);
  const version = (await store.getAgentVersion(slug)) ?? 1;
  setSlot(slots, { slug, sandbox: sandbox(version), version });
  return { slots, store, version, ...extra };
}

describe("brokerSessionUrl", () => {
  captureLogs();

  test("an unknown slug is a 404", async () => {
    const { store } = await createTestOrchestrator();
    await expect(brokerSessionUrl("ghost", { slots: createSlotCache(), store })).resolves.toEqual({
      ok: false,
      status: 404,
    });
  });

  test("a live resident answers its URLs and the version it was built from", async () => {
    const opts = await resident("live", (version) => ({ ...fakeSandbox(), version }));
    await expect(brokerSessionUrl("live", opts)).resolves.toEqual({
      ok: true,
      sessionUrl: "wss://tunnel.test:443/websocket",
      guestOrigin: "wss://tunnel.test:443",
      version: opts.version,
    });
  });

  test("a draining replica with no live resident refuses to boot one", async () => {
    const { store } = await createTestOrchestrator();
    await expect(
      brokerSessionUrl("cold", { slots: createSlotCache(), store, isDraining: () => true }),
    ).resolves.toEqual({ ok: false, status: 503 });
  });

  test("a sandbox still booting past the cap is a retryable 503", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const opts = await resident(
      "slow",
      () => fakeSandbox({ sessionUrl: () => new Promise<string>(() => undefined) }),
      { readyTimeoutMs: 50 },
    );
    const answer = brokerSessionUrl("slow", opts);
    await vi.advanceTimersByTimeAsync(50);
    await expect(answer).resolves.toMatchObject({ ok: false, status: 503 });
  });

  test("losing the name race routes to the peer that won it", async () => {
    const directory = createMemorySandboxDirectory();
    const opts = await resident(
      "raced",
      () =>
        fakeSandbox({
          sessionUrl: () => Promise.reject(new SandboxNameTakenError("agent-raced")),
        }),
      { directory },
    );
    directory.setPeer("raced", opts.version, PEER);
    await expect(brokerSessionUrl("raced", opts)).resolves.toEqual({
      ok: true,
      ...PEER,
      version: opts.version,
    });
  });

  test("losing the name race with no peer yet is a 503, not a respawn", async () => {
    const opts = await resident(
      "orphan",
      () =>
        fakeSandbox({
          sessionUrl: () => Promise.reject(new SandboxNameTakenError("agent-orphan")),
        }),
      { directory: createMemorySandboxDirectory() },
    );
    await expect(brokerSessionUrl("orphan", opts)).resolves.toMatchObject({
      ok: false,
      status: 503,
    });
  });
});

describe("brokerSessionUrlOrThrow", () => {
  captureLogs();

  /** The HTTPException a broker call threw. */
  async function thrown(call: Promise<unknown>): Promise<HTTPException> {
    const err = await call.then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof HTTPException)) throw new Error("expected an HTTPException");
    return err;
  }

  test("maps a missing agent to a 404 naming the slug", async () => {
    const { store } = await createTestOrchestrator();
    const err = await thrown(brokerSessionUrlOrThrow("ghost", { slots: createSlotCache(), store }));
    expect(err.status).toBe(404);
    expect(err.message).toBe(notFoundMessage("ghost"));
  });

  test("maps a failed boot to a 503 with the shared sentence and the cause", async () => {
    const cause = new Error("spawn failed");
    const opts = await resident("broken", () =>
      fakeSandbox({ sessionUrl: () => Promise.reject(cause) }),
    );
    const err = await thrown(brokerSessionUrlOrThrow("broken", opts));
    expect(err.status).toBe(503);
    expect(err.message).toBe(AGENT_UNAVAILABLE_MESSAGE);
    expect(err.cause).toBe(cause);
  });
});
