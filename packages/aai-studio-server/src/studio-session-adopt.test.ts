// Copyright 2026 the AAI authors. MIT license.

import { captureLogs } from "aai-server/test-utils";
import { describe, expect, test } from "vitest";
import { answering, fakeFetch } from "./_studio-fetch-test-utils.ts";
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
  // Keeps the EXPECTED warnings out of the output through the package's log
  // seam; a `spyOn(console, …)` is scaffolding standing in for that seam.
  captureLogs();

  test("installs over the guest's HTTP surface with the SANDBOX token", async () => {
    const fetchFn = fakeFetch(answering("{}", 200));
    const adopted = await adoptPeerSession(RECORD, PARAMS, { fetchFn });

    expect(adopted).toEqual({ url: RECORD.chatUrl, token: RECORD.chatToken });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    // Scheme swapped ws->http by guestHttpUrl; the route is the guest's.
    expect(url).toBe("https://peer.example/studio/session-init");
    // The per-sandbox host bearer, NOT the chat token: the caller is a
    // platform replica, and the chat token is what this call returns. Read
    // through `Headers` rather than a cast to a record: that is what the header
    // name is case-insensitively looked up in, and it needs no assumption about
    // which of `HeadersInit`'s three shapes the caller happened to pass.
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sandbox-token");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      scope: "scope",
      project: "proj",
      chatToken: "chat-token",
    });
  });

  test("returns the EXISTING chat token, never a fresh one", async () => {
    // Minted once per sandbox: re-minting here would 401 every tab already
    // holding the earlier value.
    const adopted = await adoptPeerSession(RECORD, PARAMS, {
      fetchFn: fakeFetch(answering("{}", 200)),
    });
    expect(adopted?.token).toBe(RECORD.chatToken);
  });

  test("resolves null when the guest refuses (stale row, wrong identity)", async () => {
    const fetchFn = fakeFetch(answering("nope", 409));
    expect(await adoptPeerSession(RECORD, PARAMS, { fetchFn })).toBeNull();
  });

  test("resolves null when the guest is unreachable", async () => {
    // The install IS the liveness probe — a dead peer must never have its
    // URL handed to a browser.
    const fetchFn = fakeFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    expect(await adoptPeerSession(RECORD, PARAMS, { fetchFn })).toBeNull();
  });

  test("resolves null when the guest is too slow", async () => {
    const fetchFn = fakeFetch(() => new Promise<Response>(() => undefined));
    expect(await adoptPeerSession(RECORD, PARAMS, { fetchFn, timeoutMs: 10 })).toBeNull();
  });
});
