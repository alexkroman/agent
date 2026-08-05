// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { type AdoptSessionParams, adoptPeerSession } from "./studio-session-adopt.ts";
import type { StudioSessionRecord } from "./studio-session-registry.ts";

const RECORD: StudioSessionRecord = {
  chatUrl: "https://peer.example/studio/chat",
  chatToken: "chat-token",
  guestOrigin: "wss://peer.example",
  sandboxToken: "sandbox-token",
  owner: "replica-a",
};

const PARAMS: AdoptSessionParams = {
  scope: "scope",
  project: "proj",
  files: { "agent.ts": "// v1" },
  apiKey: "caller-key",
  system: "You are a coding agent.",
  model: "gpt-5.5",
  maxSteps: 80,
};

describe("adoptPeerSession", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  test("installs over the guest's HTTP surface with the SANDBOX token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const adopted = await adoptPeerSession(RECORD, PARAMS, { fetchFn: fetchFn as never });

    expect(adopted).toEqual({ url: RECORD.chatUrl, token: RECORD.chatToken });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    // Scheme swapped ws->http by guestHttpUrl; the route is the guest's.
    expect(url).toBe("https://peer.example/studio/session-init");
    // The per-sandbox host bearer, NOT the chat token: the caller is a
    // platform replica, and the chat token is what this call returns.
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sandbox-token");
    expect(JSON.parse(String(init.body))).toMatchObject({
      scope: "scope",
      project: "proj",
      chatToken: "chat-token",
    });
  });

  test("returns the EXISTING chat token, never a fresh one", async () => {
    // Minted once per sandbox: re-minting here would 401 every tab already
    // holding the earlier value.
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const adopted = await adoptPeerSession(RECORD, PARAMS, { fetchFn: fetchFn as never });
    expect(adopted?.token).toBe(RECORD.chatToken);
  });

  test("resolves null when the guest refuses (stale row, wrong identity)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("nope", { status: 409 }));
    expect(await adoptPeerSession(RECORD, PARAMS, { fetchFn: fetchFn as never })).toBeNull();
  });

  test("resolves null when the guest is unreachable", async () => {
    // The install IS the liveness probe — a dead peer must never have its
    // URL handed to a browser.
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await adoptPeerSession(RECORD, PARAMS, { fetchFn: fetchFn as never })).toBeNull();
  });

  test("resolves null when the guest is too slow", async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => undefined));
    expect(
      await adoptPeerSession(RECORD, PARAMS, { fetchFn: fetchFn as never, timeoutMs: 10 }),
    ).toBeNull();
  });
});
