// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeFetch } from "./_test-utils.ts";
import {
  createResilientFetch,
  StaleSandboxError,
  TURN_IN_FLIGHT_MESSAGE,
  TURN_IN_FLIGHT_STATUS,
} from "./resilient-fetch.ts";

// `restoreMocks` covers spies and `unstubEnvs` covers env, but nothing in the
// shared config unstubs GLOBALS — the one test below that replaces `fetch`
// must not leave it replaced.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createResilientFetch", () => {
  it("passes a successful response through untouched", async () => {
    const body = new Response("ok", { status: 200 });
    const f = createResilientFetch({ fetchImpl: fakeFetch(() => Promise.resolve(body)) });

    await expect(f("http://sandbox.test/studio/chat")).resolves.toBe(body);
  });

  // A 401 from the GUEST is a stale session token, never a bad account: this
  // surface only ever compares the broker-minted chatToken. Routing it to
  // "re-authenticate" signed the user out of the studio.
  it("reports 401 (a stale session token) as staleness, not as a sign-out", async () => {
    const f = createResilientFetch({
      fetchImpl: fakeFetch(() => Promise.resolve(new Response("", { status: 401 }))),
    });

    const failure = await f("http://sandbox.test/studio/chat").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(StaleSandboxError);
    expect((failure as StaleSandboxError).reason).toBe("refused");
  });

  it("reports 409 (the sandbox was replaced under us) as staleness", async () => {
    const f = createResilientFetch({
      fetchImpl: fakeFetch(() => Promise.resolve(new Response("", { status: 409 }))),
    });

    await expect(f("http://sandbox.test/studio/chat")).rejects.toBeInstanceOf(StaleSandboxError);
  });

  // A busy guest is healthy. Re-brokering would reset the session the OTHER
  // tab is streaming through, and the raw JSON body would be what the panel
  // showed the user (the AI SDK surfaces a non-2xx as `Error(body text)`).
  it("reports a turn already running elsewhere without calling it staleness", async () => {
    const f = createResilientFetch({
      fetchImpl: fakeFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "busy", code: "turn_in_flight" }), {
            status: TURN_IN_FLIGHT_STATUS,
          }),
        ),
      ),
    });

    const failure = await f("http://sandbox.test/studio/chat").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(StaleSandboxError);
    expect((failure as Error).message).toBe(TURN_IN_FLIGHT_MESSAGE);
  });

  // The gap this module closes: a killed sandbox makes fetch REJECT, so a
  // wrapper that only inspects res.status never runs and the tab wedges on
  // "Failed to fetch" until a manual reload.
  it("reports an unreachable sandbox as staleness, keeping the cause", async () => {
    const boom = new TypeError("Failed to fetch");
    const f = createResilientFetch({ fetchImpl: fakeFetch(() => Promise.reject(boom)) });

    const failure = await f("http://sandbox.test/studio/chat").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(StaleSandboxError);
    // Nothing answered, as opposed to a live guest refusing us: same recovery,
    // different thing to say about it.
    expect((failure as StaleSandboxError).reason).toBe("unreachable");
    expect((failure as StaleSandboxError).cause).toBe(boom);
  });

  // The user's own wording is what they see if the retry on a fresh lease
  // fails too, so it must read as a sleeping sandbox rather than a broken page.
  it("says what happened in a sentence, not as 'Failed to fetch'", async () => {
    const f = createResilientFetch({
      fetchImpl: fakeFetch(() => Promise.reject(new TypeError("Failed to fetch"))),
    });

    await expect(f("http://sandbox.test/studio/chat")).rejects.toThrow(/sandbox/i);
  });

  it("does NOT report staleness when the user pressed Stop", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const f = createResilientFetch({ fetchImpl: fakeFetch(() => Promise.reject(abort)) });

    await expect(f("http://sandbox.test/studio/chat")).rejects.toBe(abort);
  });

  it("does NOT report staleness when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const boom = new TypeError("Failed to fetch");
    const f = createResilientFetch({ fetchImpl: fakeFetch(() => Promise.reject(boom)) });

    await expect(f("http://sandbox.test/studio/chat", { signal: controller.signal })).rejects.toBe(
      boom,
    );
  });

  it("defaults to the global fetch when no impl is injected", async () => {
    const body = new Response("ok", { status: 200 });
    const global = vi.fn(() => Promise.resolve(body));
    vi.stubGlobal("fetch", global);

    await expect(createResilientFetch()("http://sandbox.test/studio/chat")).resolves.toBe(body);
    expect(global).toHaveBeenCalledOnce();
  });
});
