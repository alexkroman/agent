// Copyright 2026 the AAI authors. MIT license.
/**
 * The broker's MEMO and caching posture. Brokering itself — the proxied
 * name/greeting, the degraded answer, the session ticket, the per-slug memo key —
 * is driven end to end in `transport-websocket.test.ts`.
 */

import { describe, expect, test, vi } from "vitest";
import { createTestOrchestrator } from "./_orchestrator-test-utils.ts";
import { deployAgent } from "./_request-test-utils.ts";
import { fakeSandbox } from "./_sandbox-test-utils.ts";
import { createSlotCache, setSlot } from "./sandbox/slots.ts";

/** A deployed `slug` with a resident fake sandbox, whose guest answers `guestFetch`. */
async function brokerWith(slug: string, guestFetch: typeof globalThis.fetch) {
  const slots = createSlotCache();
  const ctx = await createTestOrchestrator({ slots, guestFetch });
  await deployAgent(ctx.fetch, slug);
  setSlot(slots, {
    slug,
    sandbox: fakeSandbox(),
    version: (await ctx.store.getAgentVersion(slug)) ?? 1,
  });
  return ctx;
}

describe("createAgentClientConfigHandler", () => {
  test("a guest's answer is memoized: one round trip for many page loads", async () => {
    const guestFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ name: "memo-agent", page: "voice" }),
    );
    const { fetch } = await brokerWith("memo", guestFetch);
    for (let i = 0; i < 3; i++) {
      await expect((await fetch("/memo/client-config")).json()).resolves.toMatchObject({
        name: "memo-agent",
      });
    }
    expect(guestFetch).toHaveBeenCalledOnce();
  });

  test("a failed or malformed answer is NOT memoized, so a booting guest is asked again", async () => {
    const answers = [
      new Response("booting", { status: 503 }),
      Response.json({ name: 42 }),
      Response.json({ name: "ready-agent", page: "voice" }),
    ];
    const guestFetch = vi.fn<typeof globalThis.fetch>(
      async () => answers.shift() ?? new Response(),
    );
    const { fetch } = await brokerWith("boot", guestFetch);
    const first = (await (await fetch("/boot/client-config")).json()) as Record<string, unknown>;
    const second = (await (await fetch("/boot/client-config")).json()) as Record<string, unknown>;
    expect(first).not.toHaveProperty("name");
    expect(second).not.toHaveProperty("name");
    await expect((await fetch("/boot/client-config")).json()).resolves.toMatchObject({
      name: "ready-agent",
    });
    expect(guestFetch).toHaveBeenCalledTimes(3);
  });

  test("every answer is no-store and carries a fresh ticket", async () => {
    const { fetch } = await brokerWith("fresh", async () => Response.json({ page: "voice" }));
    const a = await fetch("/fresh/client-config");
    const b = await fetch("/fresh/client-config");
    expect(a.headers.get("cache-control")).toBe("no-store");
    const [ta, tb] = await Promise.all(
      [a, b].map(async (res) => ((await res.json()) as { sessionToken: string }).sessionToken),
    );
    expect(ta).not.toBe(tb);
  });
});
