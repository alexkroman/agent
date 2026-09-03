// Copyright 2026 the AAI authors. MIT license.
// Guest chat surface, UNIT tier: `handleStudioRequest`'s DISPATCH — which URLs
// it claims, the CORS preflight, the 409 with no session, the bearer gate, the
// `/studio/tools` inventory, the method refusals, and the 423 a second
// concurrent turn gets.
//
// Every one of those answers and returns before `runTurn`, so none of them
// needs the port, the workspace or the model that the turn tests need — those
// are the scenario tier's (`studio-chat.scenario.test.ts`). Splitting on what a
// test TOUCHES is the membership rule, and it is also what keeps this
// function's coverage in the tier `test:coverage` measures: moved wholesale,
// `studio-chat.ts` fell from 81.33% statements to 1.33% and took the package
// under three of its four floors.
//
// The requests are driven over IN-MEMORY `IncomingMessage`/`ServerResponse`
// rather than through `http.createServer`, so this file binds nothing. That is
// not a mock of the handler's inputs — they are the real Node objects the real
// server would hand it, and what `parseResponse` reads back is the actual
// serialized HTTP the handler wrote, status line and headers included.

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { LanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import { installFakeHostChannel } from "./_test-utils.ts";
import { setHostSend } from "./harness-rpc.ts";
import { handleStudioRequest, type StudioChatDeps } from "./studio-chat.ts";
import type { StudioSession } from "./studio-session.ts";
import { STUDIO_TOOL_LABELS } from "./studio-tools.ts";
import { enterTurn, resetTurnGate, TURN_IN_FLIGHT_CODE } from "./studio-turn-stream.ts";

const CHAT_TOKEN = "test-chat-token";
/** The caller's AssemblyAI key — the LLM credential, never the chat bearer. */
const API_KEY = "caller-key-123";

/**
 * A session as a VALUE. `StudioSession` is `StudioSessionParams & { dir }`, a
 * plain structural type, so nothing here needs `initStudioSession` — which
 * would `rm -rf` and re-materialize a workspace directory to hand back a record
 * these tests read one field of.
 */
const session: StudioSession = {
  scope: "test-scope",
  project: "proj",
  files: {},
  apiKey: API_KEY,
  chatToken: CHAT_TOKEN,
  system: "You are a coding agent.",
  // A model ID, which `LanguageModel` admits — nothing reads this field; the
  // turn resolves its model from `deps`.
  model: "fake-1",
  maxSteps: 4,
  dir: "/nonexistent",
};

/**
 * A model that replays one text step and stops. The cast is the AI SDK's shape
 * being wider than a fake needs — the same one the scenario file carries, and
 * the reason this file has any at all.
 */
const scriptedModel = {
  specificationVersion: "v3",
  provider: "fake",
  modelId: "fake-1",
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error("not implemented")),
  doStream: () => {
    const parts = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Scripted reply." },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: { unified: "stop", raw: "stop" },
      },
    ];
    return Promise.resolve({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    });
  },
} as unknown as LanguageModel;

const deps: StudioChatDeps = {
  loadBundle: async () => ({ config: { name: "A", toolSchemas: [] } }),
  executeTool: async (name) => `ran ${name}`,
  model: scriptedModel,
  typecheck: () => Promise.resolve({ ok: true, skipped: false }),
};

/** One request/response pair, wired to a socket that records the bytes. */
function exchange(
  method: string,
  headers: Record<string, string> = {},
): {
  req: IncomingMessage;
  res: ServerResponse;
  written: () => string;
  /** Resolves when the handler has ENDED the response — see below. */
  ended: Promise<void>;
} {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.headers = headers;
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const socket = new Socket();
  // `assignSocket` is what makes a detached ServerResponse writable at all;
  // intercepting `write` is what lets the assertions read the result without a
  // peer to send it to.
  socket.write = (chunk: Uint8Array | string): boolean => {
    chunks.push(Buffer.from(chunk as Uint8Array));
    return true;
  };
  res.assignSocket(socket);
  // The `end` CALL, not the `finish` EVENT. A detached response over a socket
  // that never connected writes its bytes — verified, they are in `chunks` —
  // and then never emits `finish`, so a test awaiting that event times out
  // while holding the completed response it was waiting for. `end` is the
  // handler's own last act and is what the assertions are really about.
  const { promise: ended, resolve } = Promise.withResolvers<void>();
  const end = res.end.bind(res);
  res.end = ((...args: Parameters<typeof end>) => {
    const out = end(...args);
    resolve();
    return out;
  }) as typeof res.end;
  return { req, res, written: () => Buffer.concat(chunks).toString("utf8"), ended };
}

/** The status, headers and JSON body the handler actually serialized. */
function parseResponse(raw: string): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  const [head = "", body = ""] = raw.split("\r\n\r\n");
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status: Number(statusLine.split(" ")[1]), headers, body };
}

/** Dispatch one request and read back what the handler wrote. */
function dispatch(
  url: string,
  method: string,
  options: { bearer?: string | null; session?: StudioSession | null } = {},
): { claimed: boolean; status: number; headers: Record<string, string>; body: string } {
  // DESTRUCTURING defaults, not `??`: `null` is a meaningful value on both of
  // these — "send no bearer", "there is no session" — and `??` would swallow it
  // into the default, quietly turning the 401 and 409 cases into happy paths.
  // A default applies to `undefined` alone, which is the distinction the
  // callers below are making.
  const { bearer = CHAT_TOKEN, session: on = session } = options;
  const { req, res, written } = exchange(
    method,
    bearer === null ? {} : { authorization: `Bearer ${bearer}` },
  );
  const claimed = handleStudioRequest(on, deps, req, res, url, method);
  return { claimed, ...parseResponse(written()) };
}

describe("handleStudioRequest dispatch", () => {
  test("claims only its own two URLs, so everything else can 404", () => {
    // The harness wires this in as `createServer`'s `request` hook and answers
    // 404 on false, so claiming too widely would swallow the session surfaces.
    expect(dispatch("/health", "GET").claimed).toBe(false);
    expect(dispatch("/websocket", "GET").claimed).toBe(false);
    expect(dispatch("/studio/chat", "POST", { session: null }).claimed).toBe(true);
    expect(dispatch("/studio/tools", "GET").claimed).toBe(true);
  });

  test("answers CORS preflight so the browser can call cross-origin", () => {
    const { status, headers } = dispatch("/studio/chat", "OPTIONS", { bearer: null });
    expect(status).toBe(204);
    expect(headers["access-control-allow-origin"]).toBe("*");
    expect(headers["access-control-allow-headers"]).toContain("authorization");
  });

  test("preflight is answered BEFORE the session and bearer gates", () => {
    // A browser preflight carries no authorization header and may arrive at a
    // sandbox whose session has not been installed yet; answering 401 or 409
    // there fails the real request that follows, with no way to see why.
    const { status } = dispatch("/studio/chat", "OPTIONS", { bearer: null, session: null });
    expect(status).toBe(204);
  });

  test("409s before a session is initialized", () => {
    const { status, body } = dispatch("/studio/chat", "POST", { session: null });
    expect(status).toBe(409);
    expect(JSON.parse(body)).toEqual({
      error: "No studio session loaded — re-open the project",
    });
  });

  test("rejects a missing or wrong bearer — the tunnel URL is public", () => {
    for (const bearer of [null, "wrong", API_KEY]) {
      expect(dispatch("/studio/chat", "POST", { bearer }).status).toBe(401);
    }
  });

  test("a non-POST /studio/chat is refused rather than run as a turn", () => {
    expect(dispatch("/studio/chat", "GET").status).toBe(405);
    expect(dispatch("/studio/chat", "DELETE").status).toBe(405);
  });

  // `GET /studio/tools` is the second half of this surface — public, bearer
  // gated, declared `{ via: "direct-dial" }` in guest-routes.ts — and had no
  // test anywhere. Dropping it from the `url ===` disjunction turned it into a
  // 404 the client reads as a dead sandbox, and moving the labels response
  // above `verifyBearer` leaked the tool inventory unauthenticated. Both
  // passed every test in this package.
  describe("GET /studio/tools", () => {
    test("answers the tool inventory to a valid bearer", () => {
      const { status, body } = dispatch("/studio/tools", "GET");
      // Not a 404: the client treats one as a dead sandbox and re-brokers.
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual({
        tools: Object.entries(STUDIO_TOOL_LABELS).map(([name, label]) => ({ name, label })),
      });
    });

    test("refuses an unauthenticated read of the inventory", () => {
      for (const bearer of [null, "wrong", API_KEY]) {
        const { status, body } = dispatch("/studio/tools", "GET", { bearer });
        expect(status).toBe(401);
        // The labels themselves must not ride along on the refusal.
        expect(body).not.toContain("Run command");
      }
    });

    test("a non-GET method is refused rather than treated as a turn", () => {
      expect(dispatch("/studio/tools", "POST").status).toBe(405);
    });
  });

  // These reach INTO `runTurn`, and stay unit-legal because both of its
  // rejections answer before any side effect: `readBody` and `JSON.parse` come
  // before the inbound `studio/persist-chat`, the workspace checkpointer and
  // the model. They are also the only thing that covers the dispatch TAIL —
  // the claim being taken, `res.on("close", release)`, and `runTurn` being
  // launched — which every other test here returns before reaching.
  describe("a body it cannot use", () => {
    /** POST a body and wait for whatever `runTurn` answers. */
    async function postBody(raw: string): Promise<{ status: number; body: string }> {
      const { req, res, written, ended } = exchange("POST", {
        authorization: `Bearer ${CHAT_TOKEN}`,
        "content-type": "application/json",
      });
      // Not asserted here: Biome's `noMisplacedAssertion` matches the
      // lexical position, so an `expect` inside a helper is an error — and
      // the status each caller checks already proves the request was
      // claimed, since an unclaimed one writes nothing at all.
      handleStudioRequest(session, deps, req, res, "/studio/chat", "POST");
      // The handler subscribes to `data`/`end` inside `readBody`; pushing after
      // it returns is what a real socket does too.
      req.push(raw);
      req.push(null);
      await ended;
      const { status, body } = parseResponse(written());
      return { status, body };
    }

    test("400s a body that is not JSON at all", async () => {
      const { status, body } = await postBody("not json");
      expect(status).toBe(400);
      expect(body).toContain("error");
    });

    test("400s a well-formed body whose `messages` is not an array", async () => {
      const { status, body } = await postBody(JSON.stringify({ messages: "nope" }));
      expect(status).toBe(400);
      expect(JSON.parse(body)).toEqual({ error: "messages must be an array" });
    });

    test("a body over the cap is refused rather than buffered", async () => {
      // MAX_CHAT_BODY_BYTES is 4 MB; `readBody` rejects on the chunk that
      // crosses it and destroys the request rather than accumulating.
      const { status, body } = await postBody("x".repeat(4_000_001));
      expect(status).toBe(400);
      expect(JSON.parse(body)).toEqual({ error: "Request body too large" });
    });

    test("the turn claim is RELEASED by a rejected body, not held", async () => {
      // `.finally(release)` on a request that never became a turn. Held, the
      // first malformed POST would 423 every later turn for the life of the
      // sandbox.
      await postBody("not json");
      // Polled rather than read once, and the reason is the ordering: the
      // release rides `runTurn`'s promise chain, which settles strictly AFTER
      // the `res.end` this helper anchors on — so reading the claim on the
      // very next microtask finds it still held, correctly. What is asserted
      // is that it comes back, not when.
      await vi.waitFor(() => {
        const release = enterTurn();
        expect(release).not.toBeNull();
        release?.();
      });
    });
  });

  // The turn ITSELF, which is unit-legal for a text-only step and measured to
  // be: a scripted model reaches no network, no tool runs so nothing is
  // written, and the whole exchange takes ~56ms with no port bound. What the
  // scenario tier owns is everything this cannot see — the tools landing edits
  // on a real workspace, the checkpoint, the sync, and the settle's contents.
  describe("a turn that streams", () => {
    test("answers SSE and finishes, and a lost workspace does not break it", async () => {
      // `dir` points at nothing on purpose. It is the shape a mid-turn session
      // re-install produces — `materializeWorkspace` opens with `rm -rf`, and
      // the guide's "One claim on the workspace at a time" section is about
      // exactly this window — and the claim under test is that the STREAM
      // still completes: the settle's failure is logged and swallowed, never
      // raised into the response the browser is reading.
      const host = installFakeHostChannel({ autoAnswer: true });
      const { req, res, written, ended } = exchange("POST", {
        authorization: `Bearer ${CHAT_TOKEN}`,
        "content-type": "application/json",
      });
      handleStudioRequest(session, deps, req, res, "/studio/chat", "POST");
      req.push(
        JSON.stringify({
          messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        }),
      );
      req.push(null);
      await ended;

      const { status, headers, body } = parseResponse(written());
      expect(status).toBe(200);
      expect(headers["content-type"]).toBe("text/event-stream");
      // The reply the scripted model gave, on the wire as the browser reads it.
      expect(body).toContain("Scripted reply.");
      expect(body).toContain('"type":"start"');
      // The inbound persist goes out BEFORE the turn runs, so a guest that dies
      // mid-turn still leaves the user's prompt behind — that one does not
      // depend on the workspace and must survive its absence.
      expect(host.sent.some((m) => "method" in m && m.method === "studio/persist-chat")).toBe(true);
      setHostSend(null);
    });
  });

  test("a second concurrent turn is refused, and says so in a code", () => {
    // The claim is process-wide and in-memory, so the refusal branch is
    // reachable without running a turn to hold it: taking it here is exactly
    // what an in-flight turn does. The scenario tier covers the real overlap.
    const release = enterTurn();
    try {
      const { status, body } = dispatch("/studio/chat", "POST");
      expect(status).toBe(423);
      expect(JSON.parse(body)).toMatchObject({ code: TURN_IN_FLIGHT_CODE });
    } finally {
      release?.();
      resetTurnGate();
    }
  });
});
