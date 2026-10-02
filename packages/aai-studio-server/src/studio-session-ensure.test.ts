// Copyright 2026 the AAI authors. MIT license.
/**
 * The reuse → spawn ladder and what an install IS (studio-session-ensure.ts),
 * driven through the broker that runs it under its per-project lock. The
 * cross-replica adopt rung, refresh and the lock itself stay in
 * studio-session-broker.test.ts; both share the fakes in
 * _studio-session-test-utils.ts.
 */

import { describe, expect, test } from "vitest";
import {
  type FakeGuest,
  fakeGuest,
  makeBroker,
  PROJECT,
  SCOPE,
} from "./_studio-session-test-utils.ts";
import { createWorkspace, mutateWorkspace } from "./studio-workspace.ts";

describe("session install ladder", () => {
  test("boots a sandbox, installs the session, and returns the public chat URL", async () => {
    const guest = fakeGuest();
    const { broker } = await makeBroker([guest]);
    const session = await broker.ensureSession(SCOPE, PROJECT, "caller-key");
    expect(session).toEqual({
      url: "https://tunnel.example/studio/chat",
      token: expect.any(String),
    });
    const init = guest.requests.find((r) => r.method === "studio/session-init");
    const params = init?.params as {
      apiKey: string;
      chatToken: string;
      files: Record<string, string>;
    };
    // The CALLER'S key rides to the guest — the LLM credential. The chat
    // surface's bearer is the broker-minted token, returned to the browser
    // and delivered to the guest in the same init.
    expect(params.apiKey).toBe("caller-key");
    expect(params.chatToken).toBe(session?.token);
    expect(params.chatToken.length).toBeGreaterThanOrEqual(32);
    expect(params.files["agent.ts"]).toBe("// v1");
    await broker.dispose();
  });

  // The switcher's whole payoff: the workspace's `kind` is what selects the
  // system prompt, and the selection happens at INSTALL time — so it survives
  // every reload, re-broker and cross-replica adopt, which a per-request flag
  // would not. Asserted from the guest's own init params, because that object
  // is the only thing the coding agent ever sees.
  test("installs the system prompt the project's kind selects", async () => {
    const agentGuest = fakeGuest();
    const workflowGuest = fakeGuest("wss://tunnel2.example:443");
    const { broker, workspaces } = await makeBroker([agentGuest, workflowGuest]);
    await createWorkspace(workspaces, SCOPE, "flow-proj", {
      files: { "agent.ts": "// v1" },
      kind: "workflow",
    });

    await broker.ensureSession(SCOPE, PROJECT, "caller-key");
    await broker.ensureSession(SCOPE, "flow-proj", "caller-key");

    const systemFor = (guest: FakeGuest): string | undefined => {
      const init = guest.requests.find((r) => r.method === "studio/session-init");
      return (init?.params as { system: string } | undefined)?.system;
    };
    // Each prompt states its own mode's default and not the other's — the
    // failure this guards is a workflow project's agent writing a voice agent.
    expect(systemFor(agentGuest)).toContain("Default to a VOICE agent");
    expect(systemFor(agentGuest)).not.toContain("Default to a STATIC workflow app");
    expect(systemFor(workflowGuest)).toContain("Default to a STATIC workflow app");
    expect(systemFor(workflowGuest)).not.toContain("Default to a VOICE agent");
    await broker.dispose();
  });

  // Stronger than "spawns then disposes": a missing project must not consume
  // a sandbox at all. Spawning first and discovering the 404 inside
  // session-init burned a Modal create+teardown per bogus project id, and
  // drained a warm-pool slot that a real session then had to cold-start for.
  test("returns null for a missing project without spawning a sandbox", async () => {
    const guest = fakeGuest();
    const { broker, spawn } = await makeBroker([guest]);
    expect(await broker.ensureSession(SCOPE, "ghost", "k")).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(guest.disposed()).toBe(false);
    await broker.dispose();
  });

  // The guest holds exactly ONE chatToken, so a token minted per broker call
  // invalidates the one every earlier caller is holding. Overlapping brokers
  // are routine (a second tab, another device, a reload racing an in-flight
  // one), and the loser's next chat turn then 401s on a surface where that
  // token is the only credential.
  test("hands every caller the SAME chat token while the sandbox lives", async () => {
    const guest = fakeGuest();
    const { broker, spawn } = await makeBroker([guest]);

    const first = await broker.ensureSession(SCOPE, PROJECT, "caller-key");
    const second = await broker.ensureSession(SCOPE, PROJECT, "caller-key");
    const third = await broker.ensureSession(SCOPE, PROJECT, "caller-key");

    expect(second?.token).toBe(first?.token);
    expect(third?.token).toBe(first?.token);
    // One sandbox, and every re-init installed the token it already had —
    // so no earlier caller's token was ever revoked.
    expect(spawn).toHaveBeenCalledTimes(1);
    const installed = guest.requests
      .filter((r) => r.method === "studio/session-init")
      .map((r) => (r.params as { chatToken: string }).chatToken);
    expect(installed).toEqual([first?.token, first?.token, first?.token]);
    await broker.dispose();
  });

  // The token is per-SANDBOX, not forever: a replacement sandbox is a
  // different process on a different tunnel and must not inherit a bearer
  // that leaked from the dead one.
  test("mints a fresh chat token when the sandbox is replaced", async () => {
    const dead = fakeGuest();
    const replacement = fakeGuest("wss://tunnel2.example:443");
    const { broker } = await makeBroker([dead, replacement]);

    const first = await broker.ensureSession(SCOPE, PROJECT, "caller-key");
    dead.warm.conn.dispose();
    const second = await broker.ensureSession(SCOPE, PROJECT, "caller-key");

    expect(second?.token).not.toBe(first?.token);
    expect(second?.url).toBe("https://tunnel2.example/studio/chat");
    await broker.dispose();
  });

  test("reuses the live sandbox and re-inits with the store's current files", async () => {
    const guest = fakeGuest();
    const { broker, workspaces, spawn } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    // The editor writes a file between page sessions…
    await mutateWorkspace(workspaces, SCOPE, PROJECT, (ws) => ({
      ...ws,
      files: { "agent.ts": "// v2" },
    }));
    await broker.ensureSession(SCOPE, PROJECT, "k");
    expect(spawn).toHaveBeenCalledTimes(1);
    const inits = guest.requests.filter((r) => r.method === "studio/session-init");
    expect(inits).toHaveLength(2);
    // …and the re-init must never serve a stale tree.
    const reinit = (inits[1]?.params ?? {}) as { files?: Record<string, string> };
    expect(reinit.files?.["agent.ts"]).toBe("// v2");
    await broker.dispose();
  });

  test("a dead sandbox is replaced on the next broker call", async () => {
    const first = fakeGuest();
    const second = fakeGuest("wss://tunnel2.example:443");
    const { broker, spawn } = await makeBroker([first, second]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    // Kill the first sandbox (idle eviction / crash) — re-init will reject.
    await first.warm[Symbol.asyncDispose]();
    const session = await broker.ensureSession(SCOPE, PROJECT, "k");
    expect(session?.url).toBe("https://tunnel2.example/studio/chat");
    expect(spawn).toHaveBeenCalledTimes(2);
    await broker.dispose();
  });

  /**
   * A cold spawn whose `studio/session-init` rejects must DISPOSE the guest on
   * the way out. The sandbox never lands in `sessions`, so nothing downstream
   * can reach it — not the idle sweeper, not `dispose()` — and an undisposed
   * one burns its whole orphan timeout billed while its wired handlers keep
   * writing the project behind everyone's back.
   *
   * Untested until the `installOrDispose` guard was rewritten: the invariant
   * was spelled twice (a `catch` and a trailing call) and neither spelling had
   * a spec, so the third exit that would leak had nothing to fail against.
   */
  test("a guest whose session-init fails is disposed, not left orphaned", async () => {
    const guest = fakeGuest();
    (guest.warm.conn as { sendRequest: unknown }).sendRequest = (method: string) =>
      method === "studio/session-init"
        ? Promise.reject(new Error("session-init refused"))
        : Promise.resolve({ ok: true });
    const { broker } = await makeBroker([guest]);

    await expect(broker.ensureSession(SCOPE, PROJECT, "k")).rejects.toThrow("session-init refused");
    expect(guest.disposed()).toBe(true);
    await broker.dispose();
  });
});
