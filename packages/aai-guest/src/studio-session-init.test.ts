// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's HTTP session-install surface, and the identity it pins.
 *
 * The identity check is the guest refusing to be re-purposed: a studio
 * sandbox serves one (scope, project) for its whole life, and now that ANY
 * replica can install a session over HTTP, a mis-keyed registry row would
 * otherwise materialize one tenant's workspace inside another tenant's
 * guest. Same reasoning as agent mode hash-verifying its bundle instead of
 * trusting the spawner.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { HarnessState } from "./harness-bundle.ts";
import { resetSessionIdentity } from "./studio-session.ts";
import { handleSessionInitRequest } from "./studio-session-init.ts";

const HOST_TOKEN = "host-token";

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    scope: "scope-a",
    project: "proj-a",
    files: { "agent.ts": "// v1" },
    apiKey: "caller-key",
    chatToken: "chat-token",
    system: "You are a coding agent.",
    model: "fake-1",
    maxSteps: 4,
    ...over,
  });

function fakeReq(payload: string, authorization = `Bearer ${HOST_TOKEN}`): IncomingMessage {
  const stream = Readable.from([Buffer.from(payload)]) as unknown as IncomingMessage;
  stream.headers = { authorization } as IncomingMessage["headers"];
  return stream;
}

function fakeRes() {
  let status = 0;
  const chunks: string[] = [];
  // `headersSent` is readonly on the real ServerResponse; this stand-in owns
  // it as plain state, so the shape is declared structurally and cast once.
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      res.headersSent = true;
      return res;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") chunks.push(chunk);
      return res;
    },
    destroy: () => res,
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    json: () => JSON.parse(chunks.join("")) as Record<string, unknown>,
  };
}

/**
 * Resolve once the handler's fire-and-forget install has answered.
 *
 * A wall-clock wait, not a fixed number of microtask ticks: a real install
 * materializes the workspace and runs `ensureProjectShape` against the actual
 * filesystem, so the work is I/O-bound and a tick budget that clears locally
 * runs out on a slower CI runner — which is how the first version of this
 * helper failed, as `expected +0 to be 200`.
 */
function settled(status: () => number): Promise<void> {
  return vi.waitFor(
    () => {
      if (status() === 0) throw new Error("install has not answered yet");
    },
    // Explicit rather than the 1s default: the budget has to be sized off the
    // slowest runner, and it costs nothing when the install answers promptly.
    { timeout: 4000, interval: 10 },
  );
}

describe("guest studio session-init", () => {
  beforeEach(() => {
    resetSessionIdentity();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  test("ignores requests for other routes", () => {
    const out = fakeRes();
    const state = {} as HarnessState;
    expect(
      handleSessionInitRequest(state, HOST_TOKEN, fakeReq(""), out.res, "/studio/chat", "POST"),
    ).toBe(false);
  });

  test("installs a session and pins the guest's identity", async () => {
    const out = fakeRes();
    const state = {} as HarnessState;
    handleSessionInitRequest(
      state,
      HOST_TOKEN,
      fakeReq(body()),
      out.res,
      "/studio/session-init",
      "POST",
    );
    await settled(out.status);
    expect(out.status()).toBe(200);
    expect(state.studio?.project).toBe("proj-a");
  });

  test("re-installing the SAME project is the normal path", async () => {
    const state = {} as HarnessState;
    const first = fakeRes();
    handleSessionInitRequest(
      state,
      HOST_TOKEN,
      fakeReq(body()),
      first.res,
      "/studio/session-init",
      "POST",
    );
    await settled(first.status);

    const second = fakeRes();
    handleSessionInitRequest(
      state,
      HOST_TOKEN,
      fakeReq(body({ files: { "agent.ts": "// v2" } })),
      second.res,
      "/studio/session-init",
      "POST",
    );
    await settled(second.status);
    expect(second.status()).toBe(200);
  });

  test("refuses a session-init naming a different project", async () => {
    const state = {} as HarnessState;
    const first = fakeRes();
    handleSessionInitRequest(
      state,
      HOST_TOKEN,
      fakeReq(body()),
      first.res,
      "/studio/session-init",
      "POST",
    );
    await settled(first.status);

    const second = fakeRes();
    handleSessionInitRequest(
      state,
      HOST_TOKEN,
      fakeReq(body({ project: "proj-b" })),
      second.res,
      "/studio/session-init",
      "POST",
    );
    await settled(second.status);
    expect(second.status()).toBe(409);
    expect(String(second.json().error)).toContain("refusing session-init");
    // The original session is untouched — a rejected install must not
    // half-replace the workspace the coding agent is working in.
    expect(state.studio?.project).toBe("proj-a");
  });

  test("refuses a session-init naming a different scope", async () => {
    const state = {} as HarnessState;
    const first = fakeRes();
    handleSessionInitRequest(
      state,
      HOST_TOKEN,
      fakeReq(body()),
      first.res,
      "/studio/session-init",
      "POST",
    );
    await settled(first.status);

    const second = fakeRes();
    handleSessionInitRequest(
      state,
      HOST_TOKEN,
      fakeReq(body({ scope: "scope-b" })),
      second.res,
      "/studio/session-init",
      "POST",
    );
    await settled(second.status);
    expect(second.status()).toBe(409);
  });

  test("rejects a missing or wrong bearer", async () => {
    const out = fakeRes();
    const state = {} as HarnessState;
    handleSessionInitRequest(
      state,
      HOST_TOKEN,
      fakeReq(body(), "Bearer wrong"),
      out.res,
      "/studio/session-init",
      "POST",
    );
    await settled(out.status);
    expect(out.status()).toBe(401);
    expect(state.studio).toBeUndefined();
  });

  test("rejects a malformed body", async () => {
    const out = fakeRes();
    const state = {} as HarnessState;
    handleSessionInitRequest(
      state,
      HOST_TOKEN,
      fakeReq(body({ maxSteps: 0 })),
      out.res,
      "/studio/session-init",
      "POST",
    );
    await settled(out.status);
    expect(out.status()).toBe(400);
  });

  test("rejects non-POST methods", () => {
    const out = fakeRes();
    const state = {} as HarnessState;
    handleSessionInitRequest(
      state,
      HOST_TOKEN,
      fakeReq(""),
      out.res,
      "/studio/session-init",
      "GET",
    );
    expect(out.status()).toBe(405);
  });
});
