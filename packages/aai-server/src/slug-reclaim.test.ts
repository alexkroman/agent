// Copyright 2026 the AAI authors. MIT license.
/**
 * A deleted slug is UNCLAIMED, so the next deploy of it may come from a
 * different tenant — and nothing the previous tenant held may reach the new
 * one's agent.
 *
 * Two ways it did, both through state that outlived the delete:
 *
 * - **The guest bearer.** It is `HMAC(secret, agentSandboxName(slug, version))`,
 *   and `version` restarted at 1 on a fresh insert, so the re-claimed slug's
 *   first deploy minted the deleted one's bearer byte for byte — and a guest
 *   holds its own bearer by design (`agent-store.ts`, `FRESH_VERSION_SQL`).
 * - **An ownership answer taken before the slug lock.** `existingOwnerMw`
 *   decides, then the mutation queues; a re-claim landing in between used to
 *   receive the former owner's secret write or delete (`assertStillOwner`).
 */

import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import {
  createTestOrchestrator,
  createTestStore,
  type TestFetch,
} from "./_orchestrator-test-utils.ts";
import { authFetch, bearerFor, deploy, deployAgent } from "./_request-test-utils.ts";
import { fakeAdminDbOver } from "./_sql-test-utils.ts";

const SLUG = "acme-support";

describe("the previous tenant's guest bearer", () => {
  test("does not authenticate against the agent that re-claims the slug", async () => {
    const seen: string[] = [];
    const adminDb = fakeAdminDbOver((sql) => {
      seen.push(sql);
      return [];
    });
    const p = await createTestOrchestrator({ adminDb });

    await deployAgent(p.fetch, SLUG, "key-tenant-a");
    const kept = await bearerFor(p.store, SLUG);
    const del = await authFetch(p.fetch, `/${SLUG}`, { method: "DELETE", key: "key-tenant-a" });
    expect(del.status).toBe(200);

    await deployAgent(p.fetch, SLUG, "key-tenant-b");
    expect(await bearerFor(p.store, SLUG)).not.toBe(kept);

    const res = await p.fetch(`/${SLUG}/session-state`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${kept}` },
      body: JSON.stringify({ method: "load", sessionId: "their-session" }),
    });
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });
});

describe("an owner mutation queued behind a delete and a re-claim", () => {
  /**
   * The former owner deletes (the delete holds the lock, its row not yet gone),
   * a newcomer's deploy queues for the slug, then the former owner's `mutation`
   * passes the owner check — the row is still there — and queues last.
   */
  async function raceReclaim(mutation: (fetch: TestFetch) => Promise<Response>) {
    const store = createTestStore();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let gated = false;
    const realDelete = store.deleteAgent.bind(store);
    store.deleteAgent = async (slug) => {
      if (gated) await gate;
      return realDelete(slug);
    };
    const deployed = await createTestOrchestrator({ store });

    const first = await deploy(deployed.fetch, { key: "former-owner", body: { slug: SLUG } });
    gated = true;

    const del = authFetch(deployed.fetch, `/${SLUG}`, { method: "DELETE", key: "former-owner" });
    await sleep(10);
    const claim = deploy(deployed.fetch, { key: "newcomer", body: { slug: SLUG } });
    await sleep(10);
    const late = mutation(deployed.fetch);
    await sleep(10);
    release();

    // Each step's status, so a test can see the race was the one described.
    const steps = [first.status, (await del).status, (await claim).status];
    return { store, steps, late: await late };
  }
  test("a secret write does not land in the newcomer's agent", async () => {
    const { store, steps, late } = await raceReclaim((fetch) =>
      authFetch(fetch, `/${SLUG}/secret`, {
        method: "PUT",
        key: "former-owner",
        body: { INJECTED: "attacker-value" },
      }),
    );
    expect(steps).toEqual([200, 200, 200]);
    expect(late.status).toBe(404);
    expect(await store.getEnv(SLUG)).not.toHaveProperty("INJECTED");
  });

  test("a secret delete does not reach the newcomer's agent", async () => {
    const { store, steps, late } = await raceReclaim((fetch) =>
      authFetch(fetch, `/${SLUG}/secret/ASSEMBLYAI_API_KEY`, {
        method: "DELETE",
        key: "former-owner",
      }),
    );
    expect(steps).toEqual([200, 200, 200]);
    expect(late.status).toBe(404);
    expect(await store.getEnv(SLUG)).toHaveProperty("ASSEMBLYAI_API_KEY");
  });

  test("an agent delete does not take the newcomer's agent", async () => {
    const { store, steps, late } = await raceReclaim((fetch) =>
      authFetch(fetch, `/${SLUG}`, { method: "DELETE", key: "former-owner" }),
    );
    expect(steps).toEqual([200, 200, 200]);
    expect(late.status).toBe(404);
    expect(await store.getAgent(SLUG)).not.toBeNull();
  });
});
