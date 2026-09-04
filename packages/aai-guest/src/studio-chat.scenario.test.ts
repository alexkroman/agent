// Copyright 2026 the AAI authors. MIT license.
// Guest chat surface, SCENARIO tier: a real HTTP server + the real agent loop
// and filesystem tools, with a scripted model and a fake host channel. This is
// the browser's view of the coding-agent sandbox.
//
// It binds a port, materializes a workspace on disk and — for `bash` — spawns a
// subprocess, which is what puts it here rather than in the 5s unit tier. The
// package guide names that violation outright ("A test's TIER is what it
// touches, and this package is the worst offender"), and the budget was not
// theoretical: this file lost a `vi.waitFor` race on a loaded CI runner, and
// its own in-file notes record two earlier ones at the same assertions.
//
// `handleStudioRequest`'s DISPATCH — the CORS preflight, the 409 with no
// session, the bearer gate, the `/studio/tools` inventory, the method refusals
// and the 423 — needs none of that, and stayed behind in `studio-chat.test.ts`
// driving the same exported function over in-memory req/res. That is the split
// `studio-build`/`studio-test` established: split on what a test TOUCHES, and
// keep the rest in the tier `test:coverage` measures.

import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { requestPath, sleep } from "@alexkroman1/aai/internal";
import { scriptedTextModel } from "@alexkroman1/aai-runtime/testing";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type FakeHostChannel, installFakeHostChannel } from "./_test-utils.ts";
import { pendingHostRequests, setHostSend } from "./harness-rpc.ts";
import { handleStudioRequest, type StudioChatDeps } from "./studio-chat.ts";
import { initStudioSession, type StudioSession } from "./studio-session.ts";
import { enterTurn, resetTurnGate } from "./studio-turn-stream.ts";

const API_KEY = "caller-key-123";

/**
 * The scripted model is `@alexkroman1/aai-runtime/testing`'s now.
 *
 * This file used to write the provider shape out by hand — a `doStream`
 * replaying one array of raw wire frames per call, `as unknown as
 * LanguageModel` — and so did `studio-chat.test.ts`, each copy restating the
 * `finish` frame's `{ unified, raw }` pair. That pair is a property of the WIRE
 * rather than of any spec (a bare string stops every tool from running, since
 * ai@7.0.70), which is exactly the kind of fidelity a shared harness should own.
 *
 * `pendingModel` below stays local: it is not a script but a stream the TEST
 * holds open, which is a different fake. It is built on the AI SDK's own
 * `MockLanguageModelV3` so it needs no cast either.
 */
type ScriptedPart = Record<string, unknown> & { type: string };

/**
 * A model whose stream stays open until the test ends it — the only way to
 * observe a turn while it is genuinely in flight (a concurrent post, a stream
 * that breaks mid-reply).
 */
function pendingModel(): {
  model: LanguageModel;
  started: Promise<void>;
  finish: () => void;
  fail: (error: Error) => void;
} {
  let controller: ReadableStreamDefaultController<ScriptedPart> | undefined;
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream<ScriptedPart>({
        start(c) {
          controller = c;
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "t1" });
          c.enqueue({ type: "text-delta", id: "t1", delta: "working" });
          markStarted();
        },
      }) as ReadableStream<never>,
    }),
  });
  return {
    model,
    started,
    finish: () => {
      controller?.enqueue({ type: "text-end", id: "t1" });
      controller?.enqueue({
        type: "finish",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: { unified: "stop", raw: "stop" },
      });
      controller?.close();
    },
    fail: (error: Error) => controller?.error(error),
  };
}

/** Serve handleStudioRequest on an ephemeral port; returns base URL. */
async function serve(
  session: StudioSession,
  deps: StudioChatDeps,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = requestPath(req.url);
    if (!handleStudioRequest(session, deps, req, res, url, req.method ?? "GET")) {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The channel installed by the current test, for the teardown drain below. */
let installedChannel: FakeHostChannel | null = null;

/**
 * Fake host: answers every guest→host RPC with `{}` and records the calls.
 *
 * The channel itself is the shared one (`installFakeHostChannel`) — this fake
 * was written out three times across the package, twice verbatim. What is
 * local is the projection the assertions want: the guest→host REQUESTS, in
 * order, as `{ method, params }`.
 */
function fakeHost(): { readonly calls: { method: string; params: unknown }[] } {
  const channel = installFakeHostChannel({ autoAnswer: true });
  installedChannel = channel;
  return {
    get calls() {
      return channel.sent.flatMap((msg) =>
        "method" in msg && "id" in msg ? [{ method: msg.method, params: msg.params }] : [],
      );
    },
  };
}

/**
 * Wait out any turn still settling, before unhooking the host channel.
 *
 * A turn's settle runs AFTER its response closes — `onFinish` fires, then
 * `snapshotWorkspace` walks the tree, then two host RPCs go out — and
 * `serve().close()` does not await it. So a previous test's settle landed in
 * the NEXT test's `host.calls`, which is what the in-file notes at the
 * checkpoint and sync assertions describe, and what forced their
 * `toBeGreaterThanOrEqual` + content-filter shape.
 *
 * Quiescent means all three: the process-wide turn claim is free (the response
 * closed and `runTurn` resolved), no host RPC is outstanding, and no new frame
 * arrived since the previous poll — the last one is what covers the window
 * between `onFinish` and the settle's first RPC, which is a filesystem walk
 * and therefore several macrotasks wide.
 *
 * Best-effort and bounded: a turn that never settles (a source error that
 * skips `onFinish`) must not turn every following test red, and leaving it
 * un-drained is no worse than the behaviour this replaces.
 */
async function drainTurns(): Promise<void> {
  const deadline = Date.now() + 3000;
  let previous = -1;
  while (Date.now() < deadline) {
    const seen = installedChannel?.sent.length ?? 0;
    const release = enterTurn();
    const idle = release !== null && pendingHostRequests.size === 0 && seen === previous;
    release?.();
    if (idle) return;
    previous = seen;
    await sleep(10);
  }
}

const deps = (model: LanguageModel): StudioChatDeps => ({
  loadBundle: async () => ({ config: { name: "A", toolSchemas: [] } }),
  executeTool: async (name) => `ran ${name}`,
  model,
  // A clean check, without spawning tsc. The real one is a ~0.5s compiler
  // run per write — by far the slowest thing in a scripted turn, and under
  // full-suite parallel load it alone blew this file's 5s budget. What the
  // post-write diagnostics path does with a compiler's OUTPUT is covered by
  // studio-write-diagnostics.test.ts; here it is a dependency, not the
  // subject.
  typecheck: () => Promise.resolve({ ok: true, skipped: false }),
});

const CHAT_TOKEN = "test-chat-token";

function post(url: string, body: unknown, bearer: string | null = CHAT_TOKEN): Promise<Response> {
  // An explicit null check, not `...(bearer ? … : {})`: `guard-invariants`
  // rule 22 counts the truthiness-guarded spread as debt, and the distinction
  // it is guarding is real here — `null` means "send no bearer", which is what
  // the unauthenticated cases pass.
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  return fetch(`${url}/studio/chat`, { method: "POST", headers, body: JSON.stringify(body) });
}

const chatBody = (text: string) => ({
  messages: [{ id: "m1", role: "user", parts: [{ type: "text", text }] }],
});

async function makeSession(files: Record<string, string>): Promise<StudioSession> {
  return await initStudioSession({
    scope: "test-scope",
    project: "proj",
    files,
    apiKey: API_KEY,
    chatToken: CHAT_TOKEN,
    system: "You are a coding agent.",
    model: "fake-1",
    maxSteps: 4,
  });
}

afterEach(async () => {
  await drainTurns();
  installedChannel = null;
  setHostSend(null);
  // Process-scoped, like the session identity pin — a turn left in flight by
  // one test would refuse the next one's.
  resetTurnGate();
});

describe("guest studio chat surface", () => {
  test("runs a tool-calling turn: edits land on disk and sync to the host", async () => {
    const host = fakeHost();
    const session = await makeSession({ "agent.ts": "// original" });
    const model = scriptedTextModel([
      {
        toolCalls: [
          { name: "write_file", input: { path: "agent.ts", content: "// updated by agent" } },
        ],
      },
      { text: "Rewrote agent.ts." },
    ]);
    const { url, close } = await serve(session, deps(model));
    try {
      const res = await post(url, chatBody("update the agent"));
      expect(res.status).toBe(200);
      const sse = await res.text();
      expect(sse).toContain("Rewrote agent.ts.");
      expect(sse).toContain("write_file");
      // The edit is a real file in the sandbox workspace…
      expect(await readFile(path.join(session.dir, "agent.ts"), "utf-8")).toBe(
        "// updated by agent",
      );
      // …and the settled turn pushed workspace + conversation to the host
      // (the settle runs after the stream closes, so poll for it).
      await vi.waitFor(() => {
        const methods = host.calls.map((c) => c.method);
        expect(methods).toContain("studio/sync-workspace");
        expect(methods).toContain("studio/persist-chat");
      });
      // Content-scoped for the same reason as the checkpoint test below: the
      // FIRST recorded sync is not necessarily this test's, since the fake host
      // is module-level and a prior turn can still be emitting.
      const synced = host.calls
        .filter((c) => c.method === "studio/sync-workspace")
        .map((c) => (c.params as { files?: Record<string, string> }).files?.["agent.ts"]);
      expect(synced).toContain("// updated by agent");
    } finally {
      await close();
    }
  });

  // A guest killed mid-turn used to lose everything: sync-workspace and
  // persist-chat ran only in onFinish, so an observed kill during test_agent
  // left the project at {"files":{}} with no transcript, after the agent had
  // written a complete agent.ts.
  test("checkpoints the workspace mid-turn, not only when the turn settles", async () => {
    const host = fakeHost();
    const session = await makeSession({ "agent.ts": "// original" });
    const model = scriptedTextModel([
      {
        toolCalls: [
          { name: "write_file", input: { path: "agent.ts", content: "// checkpointed" } },
        ],
      },
      // A distinctive final line, so the settle can be recognised by CONTENT
      // below rather than by counting.
      { text: "Checkpoint turn finished." },
    ]);
    const { url, close } = await serve(session, deps(model));
    try {
      // DRAIN the response before polling, and that is the ANCHOR rather than a
      // tidiness. `post()` hands back a `Response` whose SSE body nobody has
      // read, so a `vi.waitFor` started here polls its 1s default across the
      // WHOLE turn — the model steps, the tool call, the response close, the
      // workspace walk and two host RPCs. `res.text()` resolves when the stream
      // closes, which is the point this file's afterEach drain names as where
      // `onFinish` fires; what is left to poll for afterwards is just that walk
      // and those RPCs.
      //
      // Measured by squeezing this `vi.waitFor`'s timeout until it fails:
      //
      //   undrained   fails at 50ms; the test body takes 4.28s
      //   drained     fails at 50ms, PASSES at 100ms; body 353ms
      //
      // So draining leaves ~10x headroom under the 1s default where undrained
      // left the whole turn to fit inside it — which is the race this lost on a
      // loaded CI runner (`expected false to be true`, studio-chat.test.ts:408)
      // while passing 11/11 locally, coverage run included. Two sibling tests
      // below had the same shape and are drained for the same reason.
      await (await post(url, chatBody("update the agent"))).text();
      // Anchor on THIS turn's settle, then assert synchronously. The mid-turn
      // checkpoint causally PRECEDES the settle, so once the settle has landed
      // both syncs must have — which is what makes this deterministic. Waiting
      // on the syncs directly instead made the assertion a race against
      // `vi.waitFor`'s window, and under a full parallel gate it lost: it read
      // `expected 1 to be greater than or equal to 2` while passing 5/5 alone.
      await vi.waitFor(() => {
        const settled = host.calls.some(
          (call) =>
            call.method === "studio/persist-chat" &&
            JSON.stringify(call.params).includes("Checkpoint turn finished."),
        );
        expect(settled).toBe(true);
      });
      // Scoped by CONTENT, not by position. `fakeHost` installs a MODULE-LEVEL
      // sender and `close()` shuts the HTTP server without awaiting the turn, so
      // a previous test's still-running turn can push into this test's `calls` —
      // afterEach's `setHostSend(null)` only covers the gap BETWEEN tests, not an
      // overlap INTO one. That overlap is routine under full-suite load, and
      // `syncs[0]` was then a foreign sync: the flake read
      // `expected '// updated by agent' to be '// checkpointed'`, quoting a
      // string this test never writes.
      const mine = host.calls
        .filter((c) => c.method === "studio/sync-workspace")
        .map((c) => (c.params as { files?: Record<string, string> }).files?.["agent.ts"])
        .filter((content) => content === "// original" || content === "// checkpointed");
      // One from the mutating step's checkpoint, one from the settle.
      expect(mine.length).toBeGreaterThanOrEqual(2);
      expect(mine).toContain("// checkpointed");
    } finally {
      await close();
    }
  });

  test("persists the inbound conversation before the turn runs", async () => {
    const host = fakeHost();
    const session = await makeSession({ "agent.ts": "x" });
    const { url, close } = await serve(session, deps(scriptedTextModel([{ text: "Hi." }])));
    try {
      // Drained first, for the reason the checkpoint test above spells out: an
      // unread SSE body leaves the whole turn inside `vi.waitFor`'s 1s default.
      await (await post(url, chatBody("remember this prompt"))).text();
      await vi.waitFor(() => {
        const persists = host.calls.filter((c) => c.method === "studio/persist-chat");
        // Start-of-turn snapshot plus the settled one.
        expect(persists.length).toBeGreaterThanOrEqual(2);
      });
      const first = host.calls.find((c) => c.method === "studio/persist-chat");
      expect(JSON.stringify(first?.params)).toContain("remember this prompt");
    } finally {
      await close();
    }
  });

  test("a turn with no file edits does not checkpoint the workspace mid-turn", async () => {
    const host = fakeHost();
    const session = await makeSession({ "agent.ts": "x" });
    const { url, close } = await serve(
      session,
      deps(scriptedTextModel([{ text: "Just talking." }])),
    );
    try {
      // Drained first — see the checkpoint test above.
      await (await post(url, chatBody("say hi"))).text();
      // Wait for the SETTLE, not just any persist — the inbound snapshot now
      // fires at turn start, so it lands long before the turn is done.
      await vi.waitFor(() => {
        const persists = host.calls.filter((c) => c.method === "studio/persist-chat");
        expect(persists.length).toBeGreaterThanOrEqual(2);
      });
      // Only the settle's sync — a read-only turn must not spam the host.
      const syncs = host.calls.filter((c) => c.method === "studio/sync-workspace");
      expect(syncs.length).toBe(1);
    } finally {
      await close();
    }
  });

  test("bash runs real commands inside the workspace", async () => {
    fakeHost();
    const session = await makeSession({ "data.txt": "alpha\nbeta\n" });
    const model = scriptedTextModel([
      { toolCalls: [{ name: "bash", input: { command: "wc -l < data.txt && echo done" } }] },
      { text: "Counted." },
    ]);
    const { url, close } = await serve(session, deps(model));
    try {
      const sse = await (await post(url, chatBody("count lines"))).text();
      expect(sse).toContain("done");
      expect(sse).toContain("Counted.");
    } finally {
      await close();
    }
  });

  // Two tabs on one project used to stream turns into the same sandbox at
  // once: their model requests overlapped, two agents edited one workspace,
  // and the settles raced — each request carries its own whole-conversation
  // view, so the last writer erased the other tab's turn.
  test("refuses a second concurrent turn instead of interleaving it", async () => {
    fakeHost();
    const session = await makeSession({ "agent.ts": "x" });
    const pending = pendingModel();
    const { url, close } = await serve(session, deps(pending.model));
    try {
      const first = post(url, chatBody("the turn that got here first"));
      await pending.started;
      const firstRes = await first;

      const second = await post(url, chatBody("from another tab"));
      expect(second.status).toBe(423);
      expect(await second.json()).toMatchObject({ code: "turn_in_flight" });

      // The gate reopens once the first turn's response closes. (The follow-up
      // turn's own stream is left open — only its status matters here, so it is
      // aborted rather than read.)
      pending.finish();
      await firstRes.text();
      const abort = new AbortController();
      const after = await fetch(`${url}/studio/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${CHAT_TOKEN}` },
        body: JSON.stringify(chatBody("after it finished")),
        signal: abort.signal,
      });
      expect(after.status).toBe(200);
      abort.abort();
    } finally {
      await close();
    }
  });

  // `studio/session-init` opens with `rm -rf` on a path that is constant per
  // process, and the turn gate covered only `POST /studio/chat` — so a refresh
  // or a second tab deleted the workspace out from under a running turn, and
  // `settleTurn` then published the mixed tree with `done: true`.
  test("a session-init arriving mid-turn keeps the live workspace", async () => {
    fakeHost();
    const session = await makeSession({ "agent.ts": "// original" });
    const pending = pendingModel();
    const { url, close } = await serve(session, deps(pending.model));
    try {
      const first = post(url, chatBody("start working"));
      await pending.started;
      await first;
      // What a tool writes mid-turn, before any checkpoint has synced it.
      await writeFile(path.join(session.dir, "agent.ts"), "// written mid-turn", "utf-8");

      // The second tab. Same project, so the identity pin lets it through, and
      // the files it carries are the STORE's — i.e. one edit behind.
      const reinstalled = await initStudioSession({
        scope: "test-scope",
        project: "proj",
        files: { "agent.ts": "// stale copy from the store" },
        apiKey: API_KEY,
        chatToken: "second-tab-token",
        system: "You are a coding agent.",
        model: "fake-1",
        maxSteps: 4,
      });

      // The install succeeded and re-points at the same tree…
      expect(reinstalled.dir).toBe(session.dir);
      expect(reinstalled.chatToken).toBe("second-tab-token");
      // …but the running turn's work is still on disk, un-reset.
      expect(await readFile(path.join(session.dir, "agent.ts"), "utf-8")).toBe(
        "// written mid-turn",
      );

      pending.finish();
      await first.then((res) => res.text());
    } finally {
      await close();
    }
  });

  test("a session-init with no turn in flight DOES reset the workspace", async () => {
    // The other half of the rule above: outside a turn the store is the truth,
    // and a refresh must not keep serving a tree the user has since reverted.
    const session = await makeSession({ "agent.ts": "// first" });
    await writeFile(path.join(session.dir, "stray.ts"), "// left over", "utf-8");
    const again = await makeSession({ "agent.ts": "// second" });
    expect(await readFile(path.join(again.dir, "agent.ts"), "utf-8")).toBe("// second");
    await expect(readFile(path.join(again.dir, "stray.ts"), "utf-8")).rejects.toThrow();
  });

  // The measured failure: `pipeUIMessageStreamToResponse` rejects on a broken
  // model stream and its `finally` ends the response anyway, so the browser
  // saw a CLEAN end after the last delta — a half-sentence reply, no error,
  // `useChat` in `ready`, and the truncated turn persisted as the conversation.
  test("a stream that breaks mid-reply ends with an error frame, not silently", async () => {
    fakeHost();
    const session = await makeSession({ "agent.ts": "x" });
    const pending = pendingModel();
    const { url, close } = await serve(session, deps(pending.model));
    try {
      const res = await post(url, chatBody("break halfway"));
      await pending.started;
      pending.fail(new Error("gateway dropped the body"));
      const sse = await res.text();
      expect(sse).toContain("working");
      expect(sse).toContain('"type":"error"');
      expect(sse).toContain("gateway dropped the body");
    } finally {
      await close();
    }
  });

  // A blank id is what `handleUIMessageStreamFinish` falls back to without a
  // `generateMessageId`, and the blanks accumulate: the client hydrates one,
  // sends it back, and every later turn adds another — four assistant messages
  // sharing the React key "" after three reloads.
  test("persists assistant messages with a real id", async () => {
    const host = fakeHost();
    const session = await makeSession({ "agent.ts": "x" });
    const { url, close } = await serve(session, deps(scriptedTextModel([{ text: "Hello." }])));
    try {
      await (await post(url, chatBody("say hi"))).text();
      await vi.waitFor(() => {
        const settled = host.calls.filter((c) => c.method === "studio/persist-chat").at(-1);
        const { messages } = (settled?.params ?? {}) as {
          messages?: { id: string; role: string }[];
        };
        const assistant = messages?.filter((m) => m.role === "assistant") ?? [];
        expect(assistant.length).toBeGreaterThan(0);
        for (const message of assistant) expect(message.id).not.toBe("");
      });
    } finally {
      await close();
    }
  });

  test("rejects malformed bodies with 400", async () => {
    const session = await makeSession({ "agent.ts": "x" });
    const { url, close } = await serve(session, deps(scriptedTextModel([])));
    try {
      expect((await post(url, { nope: true })).status).toBe(400);
    } finally {
      await close();
    }
  });
});
