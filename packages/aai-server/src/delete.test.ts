// Copyright 2025 the AAI authors. MIT license.
import { expect, test, vi } from "vitest";
import { createOrchestrator } from "./orchestrator.ts";
import { createMemoryPlatformEvents } from "./platform-events.ts";
import { createSlotCache, setSlot } from "./sandbox-slots.ts";
import { authFetch, createTestStore, deployAgent, makeSlot, type TestFetch } from "./test-utils.ts";

async function setup() {
  // Store + event bus are a pair: the delete route only removes the row, and
  // the agents-row change stream is what terminates the resident sandbox.
  const memoryEvents = createMemoryPlatformEvents();
  const store = createTestStore(undefined, memoryEvents);
  const slots = createSlotCache();
  const { app } = createOrchestrator({
    slots,
    store,
    events: memoryEvents.events,
  });
  const fetch: TestFetch = async (input, init) => app.request(input, init);
  // `settleEvents` waits out the delete's change event AND the handler it
  // runs; see MemoryPlatformEvents.settled.
  return { fetch, store, slots, settleEvents: () => memoryEvents.settled() };
}

test("delete returns 200 for deployed agent", async () => {
  const { fetch } = await setup();
  await deployAgent(fetch);

  const resp = await authFetch(fetch, "/my-agent", { method: "DELETE" });

  expect(resp.status).toBe(200);
  const body = (await resp.json()) as Record<string, unknown>;
  expect(body).toEqual({ ok: true, message: "Deleted my-agent" });
});

test("delete removes agent from store", async () => {
  const { fetch, store } = await setup();
  await deployAgent(fetch);

  const resp = await authFetch(fetch, "/my-agent", { method: "DELETE" });
  expect(resp.status).toBe(200);

  const record = await store.getAgent("my-agent");
  expect(record).toBeNull();
});

test("delete returns 401 without auth", async () => {
  const { fetch } = await setup();
  await deployAgent(fetch);

  const resp = await fetch("/my-agent", {
    method: "DELETE",
  });

  expect(resp.status).toBe(401);
});

test("delete's change event shuts down the resident sandbox", async () => {
  const { fetch, slots, settleEvents } = await setup();
  await deployAgent(fetch);

  const shutdown = vi.fn().mockResolvedValue(undefined);
  setSlot(slots, { ...makeSlot({ slug: "my-agent" }), sandbox: { shutdown } as never });

  const resp = await authFetch(fetch, "/my-agent", { method: "DELETE" });
  expect(resp.status).toBe(200);
  await settleEvents();

  expect(shutdown).toHaveBeenCalled();
  expect(slots.has("my-agent")).toBe(false);
});

test("delete succeeds even if sandbox shutdown fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { fetch, slots, settleEvents } = await setup();
  await deployAgent(fetch);

  const shutdown = vi.fn().mockRejectedValue(new Error("shutdown failed"));
  setSlot(slots, { ...makeSlot({ slug: "my-agent" }), sandbox: { shutdown } as never });

  const resp = await authFetch(fetch, "/my-agent", { method: "DELETE" });

  expect(resp.status).toBe(200);
  await settleEvents();
  expect(shutdown).toHaveBeenCalled();
});
