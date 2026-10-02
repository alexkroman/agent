// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest→host control channel (studio-session-wire.ts): what a wired
 * sandbox's guest may ask this replica to do, and the validation each request
 * goes through. Driven through a brokered session, which is what wires a
 * guest; the fakes are shared in _studio-session-test-utils.ts.
 */

import { setImmediate } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import { fakeGuest, makeBroker, PROJECT, SCOPE } from "./_studio-session-test-utils.ts";
import { chatUrlForGuest } from "./studio-session-wire.ts";
import { getWorkspace, mutateWorkspace } from "./studio-workspace.ts";

describe("guest control channel", () => {
  test("guest sync-workspace writes through to the project store, validated", async () => {
    const guest = fakeGuest();
    const { broker, workspaces } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const sync = guest.handlers.get("studio/sync-workspace");
    await sync?.({ files: { "agent.ts": "// agent-edited" } });
    expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.files["agent.ts"]).toBe(
      "// agent-edited",
    );
    // Traversal paths are refused exactly like a client file PUT, and the
    // refusal names the offending path in ONE LINE. A `ZodError`'s own
    // `message` is `JSON.stringify(issues, null, 2)`, so a prefix match here
    // passed for as long as these three RPCs answered the guest with a
    // multi-line array of `{ code, origin, path }` objects. Every rejection
    // below pins the sentence for that reason.
    await expect(Promise.resolve(sync?.({ files: { "../evil.ts": "x" } }))).rejects.toThrow(
      "Invalid workspace sync: files.../evil.ts: Invalid key in record",
    );
    await broker.dispose();
  });

  /**
   * `read_logs`. The guest names an environment and the HOST resolves the slug
   * from the workspace, so a sandbox that is no longer the project's — or one
   * brokered with no platform origin — can read nothing at all.
   */
  test("guest agent-logs reads the project's own preview agent, or refuses", async () => {
    const guest = fakeGuest();
    const { broker, workspaces } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "caller-key", {
      serverUrl: "https://platform.example",
      userId: "user-1",
    });
    await mutateWorkspace(workspaces, SCOPE, PROJECT, (w) => ({
      ...w,
      previewSlug: "proj-preview",
    }));
    const logs = guest.handlers.get("studio/agent-logs");
    const fetchFn = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ lines: [], cursor: -1, dropped: 0, running: true })),
      );

    expect(await logs?.({})).toMatchObject({ slug: "proj-preview", running: true });
    // The account key the project's agents were deployed with, at the public
    // origin — the same pair the preview deploy uses.
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      "https://platform.example/proj-preview/logs?after=-1",
    );

    // A slug is not something the guest may pass — the schema drops it, and the
    // read still resolves the project's own preview agent.
    await expect(Promise.resolve(logs?.({ environment: "nowhere" }))).rejects.toThrow(
      'Invalid log read: environment: Invalid option: expected one of "production"|"preview"',
    );
    await broker.dispose();
  });

  test("a sandbox with no preview target may read no logs at all", async () => {
    const guest = fakeGuest();
    // Brokered WITHOUT a preview origin: no public origin, no caller key here.
    const { broker } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "caller-key");
    await expect(Promise.resolve(guest.handlers.get("studio/agent-logs")?.({}))).rejects.toThrow(
      /cannot read/,
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
    const { broker, workspaces, enqueued } = await makeBroker([guest]);
    // Brokered WITH a preview origin — that is what arms preview deploys.
    await broker.ensureSession(SCOPE, PROJECT, "caller-key", {
      serverUrl: "https://platform.example",
      userId: "user-1",
    });
    const sync = guest.handlers.get("studio/sync-workspace");

    // Mid-turn checkpoint: files land, no preview deploy.
    await sync?.({ files: { "agent.ts": "// checkpoint" } });
    await setImmediate();
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
    // The ROW names the brokering user — the only thing that lets a redelivery
    // run elsewhere (the drain resolves that user's key from Vault); a job
    // without one is ARCHIVED, so the preview silently never lands, and while
    // the broker took a bare `serverUrl` this path could not name one.
    expect(enqueued).toEqual([
      { scope: SCOPE, project: PROJECT, serverUrl: "https://platform.example", userId: "user-1" },
    ]);
    await broker.dispose();
  });

  test("a done sync without a brokered serverUrl never auto-deploys", async () => {
    const guest = fakeGuest();
    const { broker } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const sync = guest.handlers.get("studio/sync-workspace");
    await sync?.({ files: { "agent.ts": "// settled" }, done: true });
    await setImmediate();
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
    // The sentence the issue carries, not the JSON blob (see sync-workspace).
    await expect(Promise.resolve(persist?.({ messages: "all of them" }))).rejects.toThrow(
      "Invalid chat snapshot: messages: Invalid input: expected array, received string",
    );
    await broker.dispose();
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
