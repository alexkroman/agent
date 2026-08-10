// Copyright 2026 the AAI authors. MIT license.
// The bug this module exists for: a sandbox that spun down while the tab sat
// open. Everything below is about which lease a request is aimed at — the one
// captured when the chat mounted (which is what a page reload was fixing by
// hand) or the one the app holds now.

import { describe, expect, it, vi } from "vitest";
import { fakeFetch } from "./_test-utils.ts";
import type { ChatSession } from "./api.ts";
import {
  StaleSandboxError,
  TURN_IN_FLIGHT_MESSAGE,
  TURN_IN_FLIGHT_STATUS,
} from "./resilient-fetch.ts";
import { createSandboxTransport } from "./sandbox-transport.ts";

const DEAD: ChatSession = { url: "http://dead.sandbox.test/studio/chat", token: "dead-token" };
const LIVE: ChatSession = { url: "http://live.sandbox.test/studio/chat", token: "live-token" };

/** A response the AI SDK's transport accepts as the start of a turn. */
function streaming(): Response {
  return new Response('data: {"type":"start"}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** One `sendMessages` call's options, with only the parts a test varies. */
function turn(overrides: { abortSignal?: AbortSignal } = {}) {
  return {
    trigger: "submit-message" as const,
    chatId: "chat-1",
    messageId: undefined,
    messages: [],
    abortSignal: undefined,
    ...overrides,
  };
}

/** Where each request went, and which bearer it carried. */
function recordRequests(impl: (url: string) => Promise<Response>) {
  const seen: { url: string; bearer: string | null }[] = [];
  const fetchImpl = fakeFetch((input, init) => {
    const url = String(input);
    seen.push({ url, bearer: new Headers(init?.headers).get("Authorization") });
    return impl(url);
  });
  return { seen, fetchImpl };
}

describe("createSandboxTransport", () => {
  it("aims each turn at the lease the app holds NOW, not the one at mount", async () => {
    // The whole fix: `DefaultChatTransport` captures its api + headers at
    // construction, and useChat keeps one transport for the life of the
    // conversation — so a captured lease is the reason a re-broker only ever
    // reached the next page load.
    const { seen, fetchImpl } = recordRequests(() => Promise.resolve(streaming()));
    let lease = DEAD;
    const transport = createSandboxTransport({
      session: () => lease,
      rebroker: () => Promise.resolve(undefined),
      fetchImpl,
    });

    await transport.sendMessages(turn());
    lease = LIVE;
    await transport.sendMessages(turn());

    expect(seen).toEqual([
      { url: DEAD.url, bearer: `Bearer ${DEAD.token}` },
      { url: LIVE.url, bearer: `Bearer ${LIVE.token}` },
    ]);
  });

  it("re-brokers and sends the turn again when the sandbox is gone", async () => {
    // The user's report: send a message to a spun-down sandbox and the studio
    // showed "Failed to fetch" until the page was reloaded. The turn now lands
    // on the replacement instead.
    const { seen, fetchImpl } = recordRequests((url) =>
      url.startsWith("http://dead")
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(streaming()),
    );
    const rebroker = vi.fn(() => Promise.resolve(LIVE));
    const transport = createSandboxTransport({ session: () => DEAD, rebroker, fetchImpl });

    await expect(transport.sendMessages(turn())).resolves.toBeInstanceOf(ReadableStream);

    expect(rebroker).toHaveBeenCalledOnce();
    expect(seen).toEqual([
      { url: DEAD.url, bearer: `Bearer ${DEAD.token}` },
      { url: LIVE.url, bearer: `Bearer ${LIVE.token}` },
    ]);
  });

  it("re-brokers on a 409 from a live guest holding no session for us", async () => {
    const { seen, fetchImpl } = recordRequests((url) =>
      Promise.resolve(
        url.startsWith("http://dead") ? new Response("", { status: 409 }) : streaming(),
      ),
    );
    const transport = createSandboxTransport({
      session: () => DEAD,
      rebroker: () => Promise.resolve(LIVE),
      fetchImpl,
    });

    await expect(transport.sendMessages(turn())).resolves.toBeInstanceOf(ReadableStream);
    expect(seen.map((r) => r.url)).toEqual([DEAD.url, LIVE.url]);
  });

  it("retries ONCE — a replacement that is also gone fails the turn", async () => {
    // Otherwise a project whose sandbox cannot boot turns one message into an
    // unbounded chain of spawns.
    const { seen, fetchImpl } = recordRequests(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const rebroker = vi.fn(() => Promise.resolve(LIVE));
    const transport = createSandboxTransport({ session: () => DEAD, rebroker, fetchImpl });

    await expect(transport.sendMessages(turn())).rejects.toBeInstanceOf(StaleSandboxError);
    expect(rebroker).toHaveBeenCalledOnce();
    expect(seen).toHaveLength(2);
  });

  it("fails the turn when the broker has no replacement to offer", async () => {
    const { seen, fetchImpl } = recordRequests(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const transport = createSandboxTransport({
      session: () => DEAD,
      // What the app reports when the broker's own retries gave up.
      rebroker: () => Promise.resolve(undefined),
      fetchImpl,
    });

    await expect(transport.sendMessages(turn())).rejects.toBeInstanceOf(StaleSandboxError);
    expect(seen).toHaveLength(1);
  });

  it("does not re-send a turn the user stopped while we waited", async () => {
    // Stop is the user taking control back; a sandbox that finished booting
    // afterwards must not start the turn they cancelled.
    const controller = new AbortController();
    const { seen, fetchImpl } = recordRequests(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const transport = createSandboxTransport({
      session: () => DEAD,
      rebroker: () => {
        controller.abort();
        return Promise.resolve(LIVE);
      },
      fetchImpl,
    });

    await expect(
      transport.sendMessages(turn({ abortSignal: controller.signal })),
    ).rejects.toBeInstanceOf(StaleSandboxError);
    expect(seen).toHaveLength(1);
  });

  it("leaves a busy guest alone — 423 is not a stale lease", async () => {
    // The other tab's turn is streaming through that sandbox; re-brokering
    // would reset the session it is using.
    const { fetchImpl } = recordRequests(() =>
      Promise.resolve(new Response("{}", { status: TURN_IN_FLIGHT_STATUS })),
    );
    const rebroker = vi.fn(() => Promise.resolve(LIVE));
    const transport = createSandboxTransport({ session: () => DEAD, rebroker, fetchImpl });

    await expect(transport.sendMessages(turn())).rejects.toThrow(TURN_IN_FLIGHT_MESSAGE);
    expect(rebroker).not.toHaveBeenCalled();
  });

  it("passes a failure that is not staleness straight through", async () => {
    // A 2xx with no body: the sandbox answered, so nothing here is stale and
    // re-brokering would spawn a container for a bug it cannot fix.
    const { seen, fetchImpl } = recordRequests(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    const rebroker = vi.fn(() => Promise.resolve(LIVE));
    const transport = createSandboxTransport({ session: () => LIVE, rebroker, fetchImpl });

    await expect(transport.sendMessages(turn())).rejects.toThrow(/response body is empty/i);
    expect(rebroker).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("reports the wait, so the panel can say what it is waiting on", async () => {
    // "Working…" through a container boot is a stall with no explanation.
    const restarting: boolean[] = [];
    const { fetchImpl } = recordRequests((url) =>
      url.startsWith("http://dead")
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(streaming()),
    );
    const transport = createSandboxTransport({
      session: () => DEAD,
      rebroker: () => Promise.resolve(LIVE),
      onRestarting: (value) => restarting.push(value),
      fetchImpl,
    });

    await transport.sendMessages(turn());

    expect(restarting).toEqual([true, false]);
  });

  it("says the wait is over even when the retry fails", async () => {
    const restarting: boolean[] = [];
    const { fetchImpl } = recordRequests(() => Promise.reject(new TypeError("Failed to fetch")));
    const transport = createSandboxTransport({
      session: () => DEAD,
      rebroker: () => Promise.resolve(LIVE),
      onRestarting: (value) => restarting.push(value),
      fetchImpl,
    });

    await expect(transport.sendMessages(turn())).rejects.toBeInstanceOf(StaleSandboxError);
    expect(restarting).toEqual([true, false]);
  });

  it("reconnects to a stream on the current lease too", async () => {
    // A resumed stream is aimed at the sandbox by the same rules; the SDK
    // derives its path from the transport's api, so a captured lease would
    // reconnect to the dead one.
    const { seen, fetchImpl } = recordRequests(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const transport = createSandboxTransport({
      session: () => LIVE,
      rebroker: () => Promise.resolve(undefined),
      fetchImpl,
    });

    await expect(transport.reconnectToStream({ chatId: "chat-1" })).resolves.toBeNull();
    expect(seen[0]?.url).toBe(`${LIVE.url}/chat-1/stream`);
  });
});
