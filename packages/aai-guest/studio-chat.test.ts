// Copyright 2026 the AAI authors. MIT license.
// End-to-end guest chat surface: a real HTTP server + the real agent loop
// and filesystem tools, with a scripted model and a fake host channel. This
// is the browser's view of the coding-agent sandbox.

import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { handleHostResponse, setHostSend } from "./harness-rpc.ts";
import type { JsonRpcMessage } from "./harness-types.ts";
import {
  handleStudioRequest,
  initStudioSession,
  resetTurnGate,
  type StudioChatDeps,
  type StudioSession,
} from "./studio-chat.ts";

const API_KEY = "caller-key-123";

type ScriptedPart = Record<string, unknown> & { type: string };

/** Structural LanguageModel replaying one scripted stream per doStream call. */
function scriptedModel(steps: ScriptedPart[][]): LanguageModel {
  let call = 0;
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-1",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream() {
      const parts = steps[call] ?? [];
      call += 1;
      const stream = new ReadableStream<ScriptedPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      });
      return { stream };
    },
  } as unknown as LanguageModel;
}

const textStep = (text: string): ScriptedPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  {
    type: "finish",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  },
];

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
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const model = {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-pending",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream() {
      const stream = new ReadableStream<ScriptedPart>({
        start(c) {
          controller = c;
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "t1" });
          c.enqueue({ type: "text-delta", id: "t1", delta: "working" });
          markStarted();
        },
      });
      return { stream };
    },
  } as unknown as LanguageModel;
  return {
    model,
    started,
    finish: () => {
      controller?.enqueue({ type: "text-end", id: "t1" });
      controller?.enqueue({
        type: "finish",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      });
      controller?.close();
    },
    fail: (error: Error) => controller?.error(error),
  };
}

const toolStep = (toolName: string, input: Record<string, unknown>): ScriptedPart[] => [
  { type: "tool-call", toolCallId: "call1", toolName, input: JSON.stringify(input) },
  {
    type: "finish",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "tool-calls",
  },
];

/** Serve handleStudioRequest on an ephemeral port; returns base URL. */
async function serve(
  session: StudioSession,
  deps: StudioChatDeps,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
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

/** Fake host: answers every guest→host RPC with {} and records the calls. */
function fakeHost(): { calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  setHostSend((msg: JsonRpcMessage) => {
    if ("method" in msg && "id" in msg) {
      calls.push({ method: msg.method, params: (msg as { params?: unknown }).params });
      queueMicrotask(() => handleHostResponse({ id: msg.id, result: {} }));
    }
  });
  return { calls };
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
  return fetch(`${url}/studio/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
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

afterEach(() => {
  setHostSend(null);
  // Process-scoped, like the session identity pin — a turn left in flight by
  // one test would refuse the next one's.
  resetTurnGate();
});

describe("guest studio chat surface", () => {
  test("rejects a missing or wrong bearer — the tunnel URL is public", async () => {
    const session = await makeSession({ "agent.ts": "x" });
    const { url, close } = await serve(session, deps(scriptedModel([])));
    try {
      expect((await post(url, chatBody("hi"), null)).status).toBe(401);
      expect((await post(url, chatBody("hi"), "wrong")).status).toBe(401);
      // The AssemblyAI key is the LLM credential, never the chat bearer —
      // only the broker-minted per-session token opens this surface.
      expect((await post(url, chatBody("hi"), API_KEY)).status).toBe(401);
    } finally {
      await close();
    }
  });

  test("answers CORS preflight so the browser can call cross-origin", async () => {
    const session = await makeSession({ "agent.ts": "x" });
    const { url, close } = await serve(session, deps(scriptedModel([])));
    try {
      const res = await fetch(`${url}/studio/chat`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    } finally {
      await close();
    }
  });

  test("409s before a session is initialized", async () => {
    const { url, close } = await serve(null as unknown as StudioSession, deps(scriptedModel([])));
    try {
      expect((await post(url, chatBody("hi"))).status).toBe(409);
    } finally {
      await close();
    }
  });

  test("runs a tool-calling turn: edits land on disk and sync to the host", async () => {
    const host = fakeHost();
    const session = await makeSession({ "agent.ts": "// original" });
    const model = scriptedModel([
      toolStep("write_file", { path: "agent.ts", content: "// updated by agent" }),
      textStep("Rewrote agent.ts."),
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
      const sync = host.calls.find((c) => c.method === "studio/sync-workspace");
      const syncedFiles = (sync?.params ?? {}) as { files?: Record<string, string> };
      expect(syncedFiles.files?.["agent.ts"]).toBe("// updated by agent");
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
    const model = scriptedModel([
      toolStep("write_file", { path: "agent.ts", content: "// checkpointed" }),
      textStep("Done."),
    ]);
    const { url, close } = await serve(session, deps(model));
    try {
      await post(url, chatBody("update the agent"));
      await vi.waitFor(() => {
        const syncs = host.calls.filter((c) => c.method === "studio/sync-workspace");
        // One from the mutating step's checkpoint, one from the settle.
        expect(syncs.length).toBeGreaterThanOrEqual(2);
        const checkpoint = syncs[0]?.params as { files?: Record<string, string> };
        expect(checkpoint.files?.["agent.ts"]).toBe("// checkpointed");
      });
    } finally {
      await close();
    }
  });

  test("persists the inbound conversation before the turn runs", async () => {
    const host = fakeHost();
    const session = await makeSession({ "agent.ts": "x" });
    const { url, close } = await serve(session, deps(scriptedModel([textStep("Hi.")])));
    try {
      await post(url, chatBody("remember this prompt"));
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
    const { url, close } = await serve(session, deps(scriptedModel([textStep("Just talking.")])));
    try {
      await post(url, chatBody("say hi"));
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
    const model = scriptedModel([
      toolStep("bash", { command: "wc -l < data.txt && echo done" }),
      textStep("Counted."),
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
    const { url, close } = await serve(session, deps(scriptedModel([textStep("Hello.")])));
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
    const { url, close } = await serve(session, deps(scriptedModel([])));
    try {
      expect((await post(url, { nope: true })).status).toBe(400);
    } finally {
      await close();
    }
  });
});
