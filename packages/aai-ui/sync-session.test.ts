// Copyright 2026 the AAI authors. MIT license.
// Sync-session HTTP client: turn requests, history replay, error paths.

import { DEFAULT_MAX_HISTORY } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { base64ToPcm16, createSyncSession, pcm16ToBase64 } from "./sync-session.ts";

type FetchMock = ReturnType<typeof vi.fn> & typeof globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchReturning(...bodies: unknown[]): FetchMock {
  const fn = vi.fn();
  for (const body of bodies) fn.mockResolvedValueOnce(jsonResponse(body));
  return fn as FetchMock;
}

function sentBody(fetchFn: FetchMock, call = 0): Record<string, unknown> {
  const init = fetchFn.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("pcm16 base64 helpers", () => {
  test("round-trip preserves samples", () => {
    const pcm = new Int16Array([0, 1, -1, 32_767, -32_768, 12_345]);
    expect([...base64ToPcm16(pcm16ToBase64(pcm))]).toEqual([...pcm]);
  });

  test("round-trips buffers past the btoa chunk size", () => {
    const pcm = new Int16Array(40_000).map((_, i) => (i % 65_536) - 32_768);
    expect([...base64ToPcm16(pcm16ToBase64(pcm))]).toEqual([...pcm]);
  });
});

describe("createSyncSession", () => {
  test("sendText posts the turn, updates history, invokes onTurn", async () => {
    const fetchFn = fetchReturning({ transcript: "hi", reply: "hello!" });
    const onTurn = vi.fn();
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn, onTurn });

    const result = await session.sendText("hi");
    expect(result.transcript).toBe("hi");
    expect(result.reply).toBe("hello!");
    expect(result.pcm).toBeNull();
    expect(onTurn).toHaveBeenCalledWith(result);
    expect(session.history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ]);
    expect(sentBody(fetchFn)).toEqual({ text: "hi", history: [] });
  });

  test("slides the history window at the server's own limit", async () => {
    // Unbounded growth is not just memory: every turn replays the whole array,
    // and past MAX_SYNC_HISTORY_MESSAGES the server rejects the request, so a
    // long conversation used to break permanently.
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const n = (JSON.parse(init?.body as string) as { history: unknown[] }).history.length;
      return jsonResponse({ transcript: `q${n}`, reply: `a${n}` });
    }) as FetchMock;
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn });

    for (let i = 0; i < DEFAULT_MAX_HISTORY; i++) await session.sendText("hi");

    expect(session.history).toHaveLength(DEFAULT_MAX_HISTORY);
    // The window keeps the most recent turns, not the oldest.
    expect(session.history.at(-1)).toEqual({
      role: "assistant",
      content: `a${DEFAULT_MAX_HISTORY}`,
    });
    const lastSent = sentBody(fetchFn, DEFAULT_MAX_HISTORY - 1).history as unknown[];
    expect(lastSent).toHaveLength(DEFAULT_MAX_HISTORY);
  });

  test("replays accumulated history on the next turn", async () => {
    const fetchFn = fetchReturning(
      { transcript: "one", reply: "1" },
      { transcript: "two", reply: "2" },
    );
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn });
    await session.sendText("one");
    await session.sendText("two");
    expect(sentBody(fetchFn, 1).history).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "1" },
    ]);
  });

  test("sendPcm16 base64-encodes the utterance with its sample rate", async () => {
    const fetchFn = fetchReturning({ transcript: "spoken", reply: "ok" });
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn });
    const pcm = new Int16Array([10, -20, 30]);
    await session.sendPcm16(pcm, 16_000);
    const body = sentBody(fetchFn);
    expect(body.sampleRate).toBe(16_000);
    expect([...base64ToPcm16(body.audio as string)]).toEqual([...pcm]);
  });

  test("decodes reply audio into pcm", async () => {
    const spoken = new Int16Array([100, 200, -300]);
    const fetchFn = fetchReturning({
      transcript: "hi",
      reply: "hello!",
      audio: pcm16ToBase64(spoken),
      sampleRate: 24_000,
    });
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn });
    const result = await session.sendText("hi");
    expect([...(result.pcm ?? [])]).toEqual([...spoken]);
    expect(result.sampleRate).toBe(24_000);
  });

  test("HTTP error surfaces the server message and leaves history intact", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "transcription produced no speech" }, 422),
      ) as FetchMock;
    const onError = vi.fn();
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn, onError });
    const err = await session.sendText("hi").catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("HTTP 422");
    expect((err as Error).message).toContain("no speech");
    expect(onError).toHaveBeenCalledOnce();
    expect(session.history).toEqual([]);
  });

  test("a failed turn does not poison the queue", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse({ transcript: "again", reply: "ok" })) as FetchMock;
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn });
    await expect(session.sendText("first")).rejects.toThrow("network down");
    await expect(session.sendText("again")).resolves.toMatchObject({ reply: "ok" });
  });

  test("malformed server response is an error, not a crash", async () => {
    const fetchFn = fetchReturning({ nope: true });
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn });
    await expect(session.sendText("hi")).rejects.toThrow("malformed server response");
  });

  test("malformed server response names the offending field", async () => {
    const fetchFn = fetchReturning({
      transcript: "t",
      reply: "r",
      toolCalls: [{ toolCallId: "c1", toolName: "lookup", args: "not a record" }],
    });
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn });
    await expect(session.sendText("hi")).rejects.toThrow(
      /malformed server response \(toolCalls\.0\.args:/,
    );
  });

  test("unawaited turns serialize so history reaches the second request", async () => {
    let release1: ((r: Response) => void) | undefined;
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            release1 = r;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ transcript: "b", reply: "B" })));
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn as FetchMock });
    const first = session.sendText("a");
    const second = session.sendText("b");
    // Only the first request is in flight until it settles (turn dispatch
    // is queued on a microtask, so yield before asserting).
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    release1?.(jsonResponse({ transcript: "a", reply: "A" }));
    await Promise.all([first, second]);
    expect(sentBody(fetchFn as FetchMock, 1).history).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "A" },
    ]);
  });

  test("reset forgets the conversation", async () => {
    const fetchFn = fetchReturning(
      { transcript: "one", reply: "1" },
      { transcript: "two", reply: "2" },
    );
    const session = createSyncSession({ url: "http://x/sync", fetch: fetchFn });
    await session.sendText("one");
    session.reset();
    expect(session.history).toEqual([]);
    await session.sendText("two");
    expect(sentBody(fetchFn, 1).history).toEqual([]);
  });
});
