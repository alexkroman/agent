// Copyright 2026 the AAI authors. MIT license.
/** Unit test for the Soniox real-time STT adapter (mocked WebSocket). */

import { describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import { WS_OPEN_TIMEOUT_MS } from "../_socket.ts";
import { openSoniox } from "./soniox.ts";

interface FakeWSInstance {
  readyState: number;
  options?: { perMessageDeflate?: boolean } | undefined;
  bufferedAmount?: number;
  sent: Array<string | Uint8Array>;
  send(data: string | Uint8Array, opts?: unknown): void;
  close(): void;
  on(ev: string, fn: (...args: unknown[]) => void): void;
  off(ev: string, fn: (...args: unknown[]) => void): void;
  once(ev: string, fn: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
  listenerCount(): number;
  _fire(ev: string, payload?: unknown): void;
}

type Listener = (...args: unknown[]) => void;

// A local fake rather than `tts/_fake-ws-test-utils.ts`: this adapter speaks
// BINARY frames, reads `bufferedAmount` for backpressure, and reads the close
// CODE — none of which that fake models. It does share the property that
// matters, and the shared one was fixed to match it: `readyState` is
// CONNECTING until "open" fires, so a send-before-open is catchable here.
//
// `vi.mock` is hoisted above top-level decls, so share state via `vi.hoisted`.
const { latest, FakeWS } = vi.hoisted(() => {
  const latestRef: { ws: FakeWSInstance | undefined } = { ws: undefined };
  class FakeWSImpl implements FakeWSInstance {
    static OPEN = 1;
    static CLOSED = 3;
    /** When true, new sockets black-hole: no "open", no "error" — ever. */
    static neverOpen = false;
    readyState = 0;
    sent: Array<string | Uint8Array> = [];
    private listeners = new Map<string, Listener[]>();
    options: { perMessageDeflate?: boolean } | undefined;
    constructor(_url: string, opts?: { perMessageDeflate?: boolean }) {
      this.options = opts;
      if (!FakeWSImpl.neverOpen) {
        setImmediate(() => {
          this.readyState = 1;
          this.emit("open");
        });
      }
      latestRef.ws = this;
    }
    on(ev: string, fn: Listener): void {
      const arr = this.listeners.get(ev) ?? [];
      arr.push(fn);
      this.listeners.set(ev, arr);
    }
    once(ev: string, fn: Listener): void {
      const wrapped: Listener = (...args) => {
        this.off(ev, wrapped);
        fn(...args);
      };
      this.on(ev, wrapped);
    }
    off(ev: string, fn: Listener): void {
      const arr = this.listeners.get(ev);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }
    removeAllListeners(): void {
      this.listeners.clear();
    }
    listenerCount(): number {
      let n = 0;
      for (const arr of this.listeners.values()) n += arr.length;
      return n;
    }
    private emit(ev: string, ...args: unknown[]): void {
      const arr = this.listeners.get(ev)?.slice();
      if (!arr) return;
      for (const fn of arr) fn(...args);
    }
    send(data: string | Uint8Array, _opts?: unknown): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = 2;
      this.emit("close", 1000);
      this.readyState = 3;
    }
    _fire(ev: string, payload?: unknown): void {
      this.emit(ev, payload);
    }
  }
  return { latest: latestRef, FakeWS: FakeWSImpl };
});

vi.mock("ws", () => ({ default: FakeWS, WebSocket: FakeWS }));

interface OpenSessionOpts {
  apiKey?: string;
  languages?: string[];
  model?: string;
}

function openOpener(signal: AbortSignal): Promise<unknown> {
  return openSoniox({}).open({ sampleRate: 16_000, apiKey: "test-key", signal });
}

async function openSession(opts: OpenSessionOpts = {}): Promise<{
  session: import("@alexkroman1/aai/host-internal").SttSession;
  ws: FakeWSInstance;
  controller: AbortController;
}> {
  latest.ws = undefined;
  const openerOpts: { model?: string; languages?: string[] } = {};
  if (opts.model) openerOpts.model = opts.model;
  if (opts.languages) openerOpts.languages = opts.languages;
  const opener = openSoniox(openerOpts);
  const controller = new AbortController();
  const session = await opener.open({
    sampleRate: 16_000,
    apiKey: opts.apiKey ?? "test-key",
    signal: controller.signal,
  });
  const ws = latest.ws;
  if (!ws) throw new Error("no fake ws captured");
  return { session, ws, controller };
}

function frame(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

describe("Soniox real-time STT adapter", () => {
  test("openSoniox() returns an opener with name 'soniox'", () => {
    expect(openSoniox({}).name).toBe("soniox");
  });

  test("opens with permessage-deflate disabled", async () => {
    // `ws` defaults this to true on CLIENTS, and a provider that accepts the
    // offer costs a zlib context per socket (+321 KiB RSS, ~4.5x CPU, measured)
    // to compress PCM16, which does not compress. See PROVIDER_WS_OPTIONS.
    const { ws } = await openSession({});
    expect(ws.options?.perMessageDeflate).toBe(false);
  });

  test("throws stt_auth_failed when API key is missing", async () => {
    // No `vi.stubEnv` scrub: `requireApiKey` reads the key it is HANDED and
    // never `process.env`, so scrubbing the shell var proved nothing and read
    // as if a fallback existed. `host-env.test.ts` owns that property.
    const opener = openSoniox({});
    const controller = new AbortController();
    await expect(
      opener.open({ sampleRate: 16_000, apiKey: "", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "stt_auth_failed" });
  });

  test("an initial connect that black-holes fails the open instead of hanging forever", async () => {
    // A dropped SYN or a stalled proxy emits neither "open" nor "error". With
    // no deadline `waitForOpen` never settled, so `providers.open()` never
    // resolved: the ws-handler rejected the SESSION at its own timeout without
    // cancelling this connect, leaving the socket held by a pending listener
    // with no owner.
    FakeWS.neverOpen = true;
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const openPromise = openOpener(controller.signal);
      // Assert on the rejection BEFORE advancing: the timer settles the promise
      // inside `advanceTimersByTimeAsync`, and a rejection with no handler yet
      // attached is an unhandled rejection the runner reports.
      const rejected = expect(openPromise).rejects.toMatchObject({ code: "stt_connect_failed" });
      await vi.advanceTimersByTimeAsync(WS_OPEN_TIMEOUT_MS + 1);
      await rejected;
      expect(latest.ws?.readyState).toBe(3);
    } finally {
      vi.useRealTimers();
      FakeWS.neverOpen = false;
    }
  });

  test("an abort during the connect abandons the socket rather than waiting it out", async () => {
    // `closeOnAbort` is registered only AFTER the connect resolves, so before
    // this the session's own hang-up could not reach a socket still connecting.
    FakeWS.neverOpen = true;
    try {
      const controller = new AbortController();
      const openPromise = openOpener(controller.signal);
      controller.abort();
      await expect(openPromise).rejects.toMatchObject({ code: "stt_connect_failed" });
      expect(latest.ws?.readyState).toBe(3);
    } finally {
      FakeWS.neverOpen = false;
    }
  });

  test("first frame sent is the JSON config with api_key, model, audio_format, sample_rate", async () => {
    const { ws, session } = await openSession({ model: "stt-rt-v3" });

    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    const config = JSON.parse(ws.sent[0] as string);
    expect(config).toMatchObject({
      api_key: "test-key",
      model: "stt-rt-v3",
      audio_format: "pcm_s16le",
      sample_rate: 16_000,
      num_channels: 1,
    });
    expect(config.language_hints).toBeUndefined();
    await session.close();
  });

  test("the descriptor's languages are forwarded as the config frame's hints", async () => {
    const { ws, session } = await openSession({ languages: ["en", "es"] });
    const config = JSON.parse(ws.sent[0] as string);
    expect(config.language_hints).toEqual(["en", "es"]);
    await session.close();
  });

  test("non-final tokens fire 'partial' with concatenated text", async () => {
    const { session, ws } = await openSession();
    const partials: string[] = [];
    session.on("partial", (t) => partials.push(t));

    ws._fire(
      "message",
      frame({
        tokens: [
          { text: "hel", is_final: false },
          { text: "lo", is_final: false },
        ],
      }),
    );

    await flush();
    expect(partials).toEqual(["hello"]);
    await session.close();
  });

  test("finals are buffered and emitted on the next non-final boundary", async () => {
    const { session, ws } = await openSession();
    const finals: string[] = [];
    const partials: string[] = [];
    session.on("final", (t) => finals.push(t));
    session.on("partial", (t) => partials.push(t));

    ws._fire(
      "message",
      frame({
        tokens: [
          { text: "hello", is_final: true },
          { text: " world", is_final: true },
        ],
      }),
    );
    await flush();
    expect(finals).toEqual([]);

    ws._fire("message", frame({ tokens: [{ text: "how", is_final: false }] }));
    await flush();
    expect(finals).toEqual(["hello world"]);
    expect(partials).toEqual(["how"]);
    await session.close();
  });

  test("a trailing all-final utterance flushes on its own after the quiet window", async () => {
    const { session, ws } = await openSession();
    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));

    vi.useFakeTimers();
    try {
      // User stops talking; the last frame is all-final. Soniox runs without
      // endpoint detection, so nothing would flush the batched final until the
      // next utterance — the quiet timer must flush it on its own.
      ws._fire("message", frame({ tokens: [{ text: "goodbye", is_final: true }] }));
      expect(finals).toEqual([]);
      await vi.advanceTimersByTimeAsync(300);
      expect(finals).toEqual(["goodbye"]);
    } finally {
      vi.useRealTimers();
    }
    await session.close();
  });

  test("a `finished` flag flushes the trailing final buffer", async () => {
    const { session, ws } = await openSession();
    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));

    ws._fire("message", frame({ tokens: [{ text: "bye", is_final: true }], finished: true }));

    await flush();
    expect(finals).toEqual(["bye"]);
    await session.close();
  });

  test("close() also flushes any trailing final buffer", async () => {
    const { session, ws } = await openSession();
    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));

    ws._fire("message", frame({ tokens: [{ text: "trailing", is_final: true }] }));
    await flush();
    expect(finals).toEqual([]);

    await session.close();
    expect(finals).toEqual(["trailing"]);
  });

  test("close() drops the session listeners but leaves a no-op error guard", async () => {
    const { session, ws } = await openSession();
    expect(ws.listenerCount()).toBeGreaterThan(1);
    await session.close();
    // The session's message/close/error handlers (which capture emitter,
    // finalBuf, shell) are gone; only a single no-op `error` guard remains so
    // a late error during the close handshake can't crash the process.
    expect(ws.listenerCount()).toBe(1);
    expect(() => ws._fire("error", new Error("late reset"))).not.toThrow();
  });

  test("error_code in a server frame fires an stt_stream_error", async () => {
    const { session, ws } = await openSession();
    const errors: { code: string; message: string }[] = [];
    session.on("error", (e) => errors.push({ code: e.code, message: e.message }));

    ws._fire("message", frame({ error_code: 503, error_message: "service unavailable" }));

    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("stt_stream_error");
    expect(errors[0]?.message).toContain("503");
    expect(errors[0]?.message).toContain("service unavailable");
    await session.close();
  });

  test.each([
    ["a non-array tokens field", { tokens: 5 }],
    ["an object tokens field", { tokens: { text: "hi" } }],
    ["a tokens string", { tokens: "hello" }],
  ])("%s is dropped, never thrown out of the message handler", async (_label, payload) => {
    // `tokens.length === 0` is FALSE for a truthy non-array (`undefined === 0`),
    // so the frame reached `for (const tok of tokens)` and threw "not iterable"
    // straight out of `ws.on("message")` — an uncaughtException that takes down
    // a multi-tenant host rather than one session. The parse layer's contract is
    // drop, never throw; the S2S wire parse states the same rule.
    const { session, ws } = await openSession();
    const events: unknown[] = [];
    session.on("partial", () => events.push("partial"));
    session.on("final", () => events.push("final"));

    expect(() => ws._fire("message", frame(payload))).not.toThrow();

    await flush();
    expect(events).toEqual([]);
    await session.close();
  });

  test("an error_code alongside a malformed tokens field is still surfaced", async () => {
    // Dropping the bad field, not the whole frame: the error is the useful half.
    const { session, ws } = await openSession();
    const errors: string[] = [];
    session.on("error", (e) => errors.push(e.message));

    ws._fire("message", frame({ error_code: 429, error_message: "slow down", tokens: 7 }));

    await flush();
    expect(errors[0]).toContain("429");
    await session.close();
  });

  test.each([["[1,2,3]"], ['"a string"'], ["null"], ["42"]])(
    "a non-object JSON frame (%s) is ignored",
    async (body) => {
      const { session, ws } = await openSession();
      const events: unknown[] = [];
      session.on("partial", () => events.push("partial"));
      session.on("final", () => events.push("final"));
      session.on("error", () => events.push("error"));

      expect(() => ws._fire("message", Buffer.from(body))).not.toThrow();

      await flush();
      expect(events).toEqual([]);
      await session.close();
    },
  );

  test("garbage (non-JSON) frames are ignored", async () => {
    const { session, ws } = await openSession();
    const events: unknown[] = [];
    session.on("partial", () => events.push("partial"));
    session.on("final", () => events.push("final"));
    session.on("error", () => events.push("error"));

    ws._fire("message", Buffer.from("not json at all"));

    await flush();
    expect(events).toEqual([]);
    await session.close();
  });

  test("non-1000 close codes surface as stt_stream_error", async () => {
    const { session, ws } = await openSession();
    const errors: string[] = [];
    session.on("error", (e) => errors.push(e.message));

    ws._fire("close", 1011);

    await flush();
    expect(errors[0]).toContain("1011");
    await session.close();
  });

  test("sendAudio sends a binary frame with the PCM bytes when the socket is open", async () => {
    const { session, ws } = await openSession();
    const before = ws.sent.length;

    // Byte-for-byte, not just the byte COUNT: an endianness flip, a wrong
    // `byteOffset` or a zeroed buffer each send silence or noise at exactly
    // the right length, and a length-only assertion sees none of them.
    const pcm = new Int16Array([1, 2, 3, 4]);
    session.sendAudio(pcm);

    expect(ws.sent.length).toBe(before + 1);
    const sent = ws.sent.at(-1);
    expect(sent).toBeInstanceOf(Uint8Array);
    const sentView = sent as Uint8Array;
    expect(new Uint8Array(sentView.buffer, sentView.byteOffset, sentView.byteLength)).toEqual(
      new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    );
    await session.close();
  });

  test("sendAudio drops frames while the socket buffer exceeds the cap, then resumes", async () => {
    const { session, ws } = await openSession();
    const before = ws.sent.length;

    ws.bufferedAmount = 8 * 1024 * 1024;
    session.sendAudio(new Int16Array([1, 2, 3]));
    expect(ws.sent.length).toBe(before);

    ws.bufferedAmount = 0;
    session.sendAudio(new Int16Array([1, 2, 3]));
    expect(ws.sent.length).toBe(before + 1);
    await session.close();
  });

  test("close() is idempotent and silences subsequent token frames", async () => {
    const { session, ws } = await openSession();
    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));

    await session.close();
    await session.close();

    ws._fire("message", frame({ tokens: [{ text: "ignored", is_final: true }], finished: true }));

    await flush();
    expect(finals).toEqual([]);
  });
});
