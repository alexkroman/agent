// Copyright 2026 the AAI authors. MIT license.

import { createMemoryChatStore } from "aai-server/chat-store";
import type { GuestConnection } from "aai-server/rpc-schemas";
import type { WarmHarness } from "aai-server/sandbox-vm";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { describe, expect, test, vi } from "vitest";
import { chatUrlForGuest, createStudioSessionBroker } from "./studio-session-broker.ts";
import { createMemoryStudioSessionRegistry } from "./studio-session-registry.ts";
import { createWorkspace, getWorkspace } from "./studio-workspace.ts";

const SCOPE = "scope";
const PROJECT = "proj";

type FakeGuest = {
  warm: WarmHarness;
  requests: { method: string; params: unknown }[];
  handlers: Map<string, (params: unknown) => unknown>;
  disposed: () => boolean;
};

function fakeGuest(guestOrigin = "wss://tunnel.example:443"): FakeGuest {
  const requests: FakeGuest["requests"] = [];
  const handlers = new Map<string, (params: unknown) => unknown>();
  let disposed = false;
  const conn = {
    sendRequest: async (method: string, params?: unknown) => {
      if (disposed) throw new Error("Connection disposed");
      requests.push({ method, params });
      if (method === "workspace/deploy") {
        return {
          ok: true,
          slug: "proj",
          url: "https://platform.example/proj",
          output: "Deployed https://platform.example/proj",
        };
      }
      return { ok: true };
    },
    sendNotification: () => undefined,
    onRequest: (method: string, handler: (params: unknown) => unknown) => {
      handlers.set(method, handler);
    },
    onNotification: () => undefined,
    listen: () => undefined,
    dispose: () => {
      disposed = true;
    },
  } as unknown as GuestConnection;
  const warm = {
    conn,
    guestOrigin,
    token: "sandbox-token",
    sessionUrl: `${guestOrigin}/websocket`,
    [Symbol.asyncDispose]: async () => {
      disposed = true;
    },
  } as unknown as WarmHarness;
  return { warm, requests, handlers, disposed: () => disposed };
}

async function makeBroker(
  guests: FakeGuest[],
  extra: Partial<Parameters<typeof createStudioSessionBroker>[0]> = {},
) {
  const workspaces = createMemoryWorkspaceStore();
  const chats = createMemoryChatStore();
  await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
  let spawned = 0;
  const spawn = vi.fn(async () => {
    const guest = guests[spawned];
    spawned += 1;
    if (!guest) throw new Error("no more fake guests");
    return guest.warm;
  });
  const broker = createStudioSessionBroker({
    workspaces,
    chats,
    spawn: spawn as never,
    harnessPath: "/fake/harness.mjs",
    ...extra,
  });
  return { broker, workspaces, chats, spawn };
}

describe("studio session broker", () => {
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
    const { mutateWorkspace } = await import("./studio-workspace.ts");
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

  test("refreshSession re-installs a live sandbox with the pushed files", async () => {
    // `aai push` writes the workspace from outside the studio. The live
    // guest materialized its tree at install, so without this the agent
    // reads pre-push files — and syncs them back at end of turn.
    const guest = fakeGuest();
    const { broker, workspaces, spawn } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const { syncWorkspaceSource } = await import("./studio-workspace.ts");
    await syncWorkspaceSource(workspaces, SCOPE, PROJECT, { "agent.ts": "// pushed" });

    expect(await broker.refreshSession(SCOPE, PROJECT, "k")).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const inits = guest.requests.filter((r) => r.method === "studio/session-init");
    expect(inits).toHaveLength(2);
    const reinit = (inits[1]?.params ?? {}) as { files?: Record<string, string> };
    expect(reinit.files?.["agent.ts"]).toBe("// pushed");
    await broker.dispose();
  });

  test("refreshSession never spawns — no live sandbox means nothing is stale", async () => {
    const { broker, spawn } = await makeBroker([fakeGuest()]);
    expect(await broker.refreshSession(SCOPE, PROJECT, "k")).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
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

  test("guest sync-workspace writes through to the project store, validated", async () => {
    const guest = fakeGuest();
    const { broker, workspaces } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const sync = guest.handlers.get("studio/sync-workspace");
    await sync?.({ files: { "agent.ts": "// agent-edited" } });
    expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.files["agent.ts"]).toBe(
      "// agent-edited",
    );
    // Traversal paths are refused exactly like a client file PUT.
    await expect(Promise.resolve(sync?.({ files: { "../evil.ts": "x" } }))).rejects.toThrow(
      /Invalid workspace sync/,
    );
    await broker.dispose();
  });

  /**
   * The auto preview trigger is the guest's TURN-COMPLETE sync (`done:
   * true`, the analog of opencode's `session.idle` / codex's
   * `agent-turn-complete`). Mid-turn checkpoints share the RPC method but
   * carry no flag — deploying those would ship half-finished trees.
   */
  test("a done sync auto-deploys a preview; checkpoints do not", async () => {
    const guest = fakeGuest();
    const { broker, workspaces } = await makeBroker([guest]);
    // Brokered WITH a serverUrl — that is what arms preview deploys.
    await broker.ensureSession(SCOPE, PROJECT, "caller-key", "https://platform.example");
    const sync = guest.handlers.get("studio/sync-workspace");

    // Mid-turn checkpoint: files land, no preview deploy.
    await sync?.({ files: { "agent.ts": "// checkpoint" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(guest.requests.some((r) => r.method === "workspace/deploy")).toBe(false);

    // Turn-complete sync: the preview deploys to `<project>-preview`, on
    // the live session sandbox, and stamps the workspace metadata.
    await sync?.({ files: { "agent.ts": "// settled" }, done: true });
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewHash).toBeDefined();
    });
    const deploy = guest.requests.find((r) => r.method === "workspace/deploy");
    expect(deploy?.params).toMatchObject({
      serverUrl: "https://platform.example",
      apiKey: "caller-key",
      slug: `${PROJECT}-preview`,
      files: { "agent.ts": "// settled" },
    });
    await broker.dispose();
  });

  test("a done sync without a brokered serverUrl never auto-deploys", async () => {
    const guest = fakeGuest();
    const { broker } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const sync = guest.handlers.get("studio/sync-workspace");
    await sync?.({ files: { "agent.ts": "// settled" }, done: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(guest.requests.some((r) => r.method === "workspace/deploy")).toBe(false);
    await broker.dispose();
  });

  test("guest persist-chat writes the conversation row", async () => {
    const guest = fakeGuest();
    const { broker, chats } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const persist = guest.handlers.get("studio/persist-chat");
    const history = [{ id: "m1", role: "user", parts: [] }];
    await persist?.({ messages: history });
    expect(await chats.getChat(SCOPE, PROJECT)).toEqual(history);
    await broker.dispose();
  });

  const TARGET = { serverUrl: "https://platform.example", apiKey: "caller-key", slug: "proj" };

  test("deployWorkspace reuses the project's live sandbox", async () => {
    const guest = fakeGuest();
    const { broker, spawn } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const outcome = await broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "x" }, TARGET);
    expect(outcome).toEqual({
      ok: true,
      slug: "proj",
      url: "https://platform.example/proj",
      output: "Deployed https://platform.example/proj",
    });
    // Rode the live session sandbox — nothing new spawned.
    expect(spawn).toHaveBeenCalledTimes(1);
    const deploy = guest.requests.find((r) => r.method === "workspace/deploy");
    expect(deploy?.params).toEqual({
      files: { "agent.ts": "x" },
      serverUrl: "https://platform.example",
      apiKey: "caller-key",
      slug: "proj",
    });
  });

  test("deployWorkspace without a live session uses an ephemeral sandbox", async () => {
    const guest = fakeGuest();
    const { broker, spawn } = await makeBroker([guest]);
    const outcome = await broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "x" }, TARGET);
    expect(outcome.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    // Torn down after the publish — no orphaned sandbox for the broker to own.
    expect(guest.disposed()).toBe(true);
  });

  test("deployWorkspace passes a failed CLI run through as-is", async () => {
    const guest = fakeGuest();
    (guest.warm.conn as { sendRequest: unknown }).sendRequest = async () => ({
      ok: false,
      output: "Build failed:\nagent.ts:1: oops",
    });
    const { broker } = await makeBroker([guest]);
    const outcome = await broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "x" }, TARGET);
    expect(outcome).toEqual({ ok: false, output: "Build failed:\nagent.ts:1: oops" });
  });

  test("deployWorkspace rejects a malformed guest response", async () => {
    const guest = fakeGuest();
    (guest.warm.conn as { sendRequest: unknown }).sendRequest = async () => ({ ok: "yes" });
    const { broker } = await makeBroker([guest]);
    const outcome = await broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "x" }, TARGET);
    expect(outcome).toMatchObject({
      ok: false,
      output: expect.stringContaining("Malformed deploy response"),
    });
  });

  /**
   * Two `POST /studio/projects/:project/session` calls for one project can
   * overlap (double-click, a StrictMode double-effect, a refresh landing on
   * an in-flight broker). Unserialized, both take the cold path and the
   * loser's sandbox is orphaned: it never lands in `sessions`, so neither
   * the idle sweeper nor `dispose()` can reach it — it burns its orphan
   * timeout billed, while its still-wired `studio/sync-workspace` handler
   * keeps writing the project behind the tracked sandbox's back.
   */
  test("concurrent sessions for one project share a single sandbox", async () => {
    const first = fakeGuest();
    const second = fakeGuest("wss://tunnel2.example:443");
    const { broker, spawn } = await makeBroker([first, second]);

    const [a, b] = await Promise.all([
      broker.ensureSession(SCOPE, PROJECT, "k"),
      broker.ensureSession(SCOPE, PROJECT, "k"),
    ]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(a?.url).toBe(b?.url);
    // The unused guest was never spawned, so nothing is left untracked.
    expect(second.disposed()).toBe(false);
    await broker.dispose();
    expect(first.disposed()).toBe(true);
  });

  test("sessions for different projects are not serialized against each other", async () => {
    const first = fakeGuest();
    const second = fakeGuest("wss://tunnel2.example:443");
    const { broker, workspaces, spawn } = await makeBroker([first, second]);
    await createWorkspace(workspaces, SCOPE, "other", { files: { "agent.ts": "// o" } });

    const [a, b] = await Promise.all([
      broker.ensureSession(SCOPE, PROJECT, "k"),
      broker.ensureSession(SCOPE, "other", "k"),
    ]);

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(a?.url).not.toBe(b?.url);
    await broker.dispose();
  });

  /**
   * `deployWorkspace` drops the project's entry when its sandbox fails
   * mid-publish. That cleanup runs after an await, so it must remove its OWN
   * entry — by then the client may have re-brokered and installed a
   * replacement, and evicting that one strands a live sandbox nothing owns.
   */
  test("a failed publish does not evict a session installed while it ran", async () => {
    const first = fakeGuest();
    const second = fakeGuest("wss://tunnel2.example:443");
    let failDeploy!: (err: Error) => void;
    (first.warm.conn as { sendRequest: unknown }).sendRequest = (method: string) => {
      if (method === "workspace/deploy") {
        return new Promise((_resolve, reject) => {
          failDeploy = reject;
        });
      }
      // Once the sandbox is gone, re-init rejects — as the real one does.
      return first.disposed()
        ? Promise.reject(new Error("Connection disposed"))
        : Promise.resolve({ ok: true });
    };

    // 3rd: the ephemeral sandbox the failed publish retries on. A 4th is
    // only ever reached if the publish's cleanup evicted the replacement.
    const ephemeral = fakeGuest("wss://tunnel3.example:443");
    const fourth = fakeGuest("wss://tunnel4.example:443");
    const { broker } = await makeBroker([first, second, ephemeral, fourth]);
    await broker.ensureSession(SCOPE, PROJECT, "k");

    // Publish starts against the live sandbox and stalls.
    const publish = broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "x" }, TARGET);
    // The sandbox dies, the client re-brokers, a replacement is installed.
    await first.warm[Symbol.asyncDispose]();
    const replacement = await broker.ensureSession(SCOPE, PROJECT, "k");
    expect(replacement?.url).toBe("https://tunnel2.example/studio/chat");

    // Only now does the stalled publish notice and run its cleanup.
    failDeploy(new Error("sandbox gone"));
    await publish.catch(() => undefined);

    // The replacement must still be the project's session — reusable, and
    // reachable by dispose().
    const after = await broker.ensureSession(SCOPE, PROJECT, "k");
    expect(after?.url).toBe("https://tunnel2.example/studio/chat");
    await broker.dispose();
    expect(second.disposed()).toBe(true);
  });
});

describe("chatUrlForGuest", () => {
  test("maps the voice endpoint to the https chat endpoint", () => {
    expect(chatUrlForGuest("wss://h.modal.host:12345")).toBe(
      "https://h.modal.host:12345/studio/chat",
    );
    expect(chatUrlForGuest("ws://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/studio/chat");
  });
});

describe("studio publish (workspace/deploy)", () => {
  // Publish output is posted into the chat for the coding agent to read, so a
  // sandbox that dies mid-build (an OOM at the bundler's peak is the
  // realistic one) has to come back as deploy OUTPUT. Thrown, it reached the
  // route as a bare 500 with nothing anyone could act on.
  test("a sandbox that dies mid-publish returns failure output, not a throw", async () => {
    const guest = fakeGuest();
    // No live chat session for this project, so Publish spawns its own
    // sandbox — the path that had no error handling at all.
    guest.warm.conn.dispose();
    const { broker } = await makeBroker([guest]);

    const outcome = await broker.deployWorkspace(
      SCOPE,
      PROJECT,
      { "agent.ts": "// v1" },
      {
        serverUrl: "https://platform.example",
        apiKey: "caller-key",
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/stopped responding/i);
    expect(outcome.output).toMatch(/out of memory/i);
    await broker.dispose();
  });

  // The other half of the same path: killing the sandbox early enough means
  // the SPAWN fails (the dial times out) rather than the deploy RPC. Same
  // user-visible situation, and it took the same unhandled route to a 500.
  test("a sandbox that never starts returns failure output, not a throw", async () => {
    const workspaces = createMemoryWorkspaceStore();
    const chats = createMemoryChatStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
    const broker = createStudioSessionBroker({
      workspaces,
      chats,
      spawn: (async () => {
        throw new Error("guest WebSocket not dialable after 30000ms");
      }) as never,
      harnessPath: "/fake/harness.mjs",
    });

    const outcome = await broker.deployWorkspace(
      SCOPE,
      PROJECT,
      { "agent.ts": "// v1" },
      {
        serverUrl: "https://platform.example",
        apiKey: "caller-key",
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/could not start a build sandbox/i);
    expect(outcome.output).toMatch(/nothing was deployed/i);
    await broker.dispose();
  });

  // `afterDeploy` is what lets a per-deploy consequence — the studio uses it
  // to give a newly claimed slug the database its project asked for — be
  // wired ONCE for both deploy paths (Publish and the auto preview) instead
  // of into one and forgotten in the other.
  test("afterDeploy runs with the claimed slug, on success only", async () => {
    const afterDeploy = vi.fn(async () => undefined);
    const { broker } = await makeBroker([fakeGuest(), fakeGuest()], { afterDeploy });
    const target = { serverUrl: "https://platform.example", apiKey: "caller-key" };

    await broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "// v1" }, target);
    expect(afterDeploy).toHaveBeenCalledWith(SCOPE, PROJECT, "proj");

    // A failed deploy claimed nothing, so there is nothing to reconcile.
    afterDeploy.mockClear();
    const dead = fakeGuest();
    dead.warm.conn.dispose();
    const failing = await makeBroker([dead], { afterDeploy });
    const outcome = await failing.broker.deployWorkspace(
      SCOPE,
      PROJECT,
      { "agent.ts": "// v1" },
      target,
    );
    expect(outcome.ok).toBe(false);
    expect(afterDeploy).not.toHaveBeenCalled();
    await broker.dispose();
    await failing.broker.dispose();
  });

  test("a failing afterDeploy never turns a shipped deploy into an error", async () => {
    // The CLI output is already on its way to the chat; reporting a transport
    // failure over a follow-up would be a lie about what happened.
    const afterDeploy = vi.fn(async () => {
      throw new Error("vault unavailable");
    });
    const { broker } = await makeBroker([fakeGuest()], { afterDeploy });
    const outcome = await broker.deployWorkspace(
      SCOPE,
      PROJECT,
      { "agent.ts": "// v1" },
      { serverUrl: "https://platform.example", apiKey: "caller-key" },
    );
    expect(outcome.ok).toBe(true);
    await broker.dispose();
  });
});

describe("cross-replica studio sessions", () => {
  /** A broker wired as one replica of a fleet sharing `registry`. */
  async function makeReplica(
    replicaId: string,
    guests: FakeGuest[],
    shared: {
      workspaces: ReturnType<typeof createMemoryWorkspaceStore>;
      chats: ReturnType<typeof createMemoryChatStore>;
      registry: ReturnType<typeof createMemoryStudioSessionRegistry>;
    },
    adopt?: unknown,
  ) {
    let spawned = 0;
    const spawn = vi.fn(async () => {
      const guest = guests[spawned];
      spawned += 1;
      if (!guest) throw new Error("no more fake guests");
      return guest.warm;
    });
    const broker = createStudioSessionBroker({
      workspaces: shared.workspaces,
      chats: shared.chats,
      registry: shared.registry,
      replicaId,
      spawn: spawn as never,
      harnessPath: "/fake/harness.mjs",
      ...(adopt ? { adopt: adopt as never } : {}),
    });
    return { broker, spawn };
  }

  async function sharedFleet() {
    const workspaces = createMemoryWorkspaceStore();
    const chats = createMemoryChatStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
    return { workspaces, chats, registry: createMemoryStudioSessionRegistry() };
  }

  test("a second replica adopts the first's sandbox instead of spawning", async () => {
    // The reported bug, at the studio layer: replica B's `sessions` map is
    // empty, so before the registry it took the cold path and spawned a
    // duplicate guest for a project already running on replica A.
    const shared = await sharedFleet();
    const guestA = fakeGuest("wss://guest-a.example:443");
    const a = await makeReplica("replica-a", [guestA], shared);
    const first = await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");

    const adopt = vi.fn(async () => ({
      url: "https://guest-a.example/studio/chat",
      token: first?.token as string,
    }));
    const b = await makeReplica(
      "replica-b",
      [fakeGuest("wss://guest-b.example:443")],
      shared,
      adopt,
    );
    const second = await b.broker.ensureSession(SCOPE, PROJECT, "caller-key");

    expect(b.spawn).not.toHaveBeenCalled();
    // Same URL and the SAME chat token — a tab brokered by either replica
    // must be able to keep using the token it already holds.
    expect(second).toEqual(first);
    // And the peer got the workspace, so it never edits a stale tree.
    const call = adopt.mock.calls[0] as unknown as [unknown, { files: Record<string, string> }];
    expect(call[1].files).toEqual({ "agent.ts": "// v1" });
  });

  test("a peer whose guest is unreachable falls back to a local spawn", async () => {
    const shared = await sharedFleet();
    const guestA = fakeGuest("wss://guest-a.example:443");
    const a = await makeReplica("replica-a", [guestA], shared);
    await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");

    const adopt = vi.fn(async () => null);
    const guestB = fakeGuest("wss://guest-b.example:443");
    const b = await makeReplica("replica-b", [guestB], shared, adopt);
    const session = await b.broker.ensureSession(SCOPE, PROJECT, "caller-key");

    expect(adopt).toHaveBeenCalled();
    expect(b.spawn).toHaveBeenCalledTimes(1);
    expect(session?.url).toBe("https://guest-b.example/studio/chat");
    // The dead row was dropped and replaced by the new owner's.
    expect(await shared.registry.get(SCOPE, PROJECT)).toMatchObject({ owner: "replica-b" });
  });

  test("the owning replica reuses its own sandbox rather than adopting", async () => {
    const shared = await sharedFleet();
    const guest = fakeGuest();
    const adopt = vi.fn(async () => null);
    const a = await makeReplica("replica-a", [guest], shared, adopt);
    await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");
    await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");
    expect(a.spawn).toHaveBeenCalledTimes(1);
    expect(adopt).not.toHaveBeenCalled();
  });

  test("a cold spawn claims the registry row with the guest's own credentials", async () => {
    const shared = await sharedFleet();
    const guest = fakeGuest("wss://guest-a.example:443");
    const a = await makeReplica("replica-a", [guest], shared);
    const session = await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");
    expect(await shared.registry.get(SCOPE, PROJECT)).toEqual({
      chatUrl: session?.url,
      chatToken: session?.token,
      guestOrigin: "wss://guest-a.example:443",
      sandboxToken: "sandbox-token",
      owner: "replica-a",
    });
  });

  test("disposing releases the row so the next broker call spawns fresh", async () => {
    const shared = await sharedFleet();
    const a = await makeReplica("replica-a", [fakeGuest()], shared);
    await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");
    await a.broker.dispose();
    expect(await shared.registry.get(SCOPE, PROJECT)).toBeNull();
  });
});
