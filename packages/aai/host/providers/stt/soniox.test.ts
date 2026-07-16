// Copyright 2026 the AAI authors. MIT license.
/** Unit test for the Soniox real-time STT adapter (mocked WebSocket). */

import { describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import { openSoniox } from "./soniox.ts";

interface FakeWSInstance {
  readyState: number;
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

// `vi.mock` is hoisted above top-level decls, so share state via `vi.hoisted`.
const { latest, FakeWS } = vi.hoisted(() => {
  const latestRef: { ws: FakeWSInstance | undefined } = { ws: undefined };
  class FakeWSImpl implements FakeWSInstance {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    sent: Array<string | Uint8Array> = [];
    private listeners = new Map<string, Listener[]>();
    constructor(_url: string) {
      setImmediate(() => {
        this.readyState = 1;
        this.emit("open");
      });
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
  languageHints?: string[];
  model?: string;
}

async function openSession(opts: OpenSessionOpts = {}): Promise<{
  session: import("../../../sdk/providers.ts").SttSession;
  ws: FakeWSInstance;
  controller: AbortController;
}> {
  latest.ws = undefined;
  const openerOpts: { model?: string; languageHints?: string[] } = {};
  if (opts.model) openerOpts.model = opts.model;
  if (opts.languageHints) openerOpts.languageHints = opts.languageHints;
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

  test("throws stt_auth_failed when API key is missing", async () => {
    const saved = process.env.SONIOX_API_KEY;
    delete process.env.SONIOX_API_KEY;

    const opener = openSoniox({});
    const controller = new AbortController();
    await expect(
      opener.open({ sampleRate: 16_000, apiKey: "", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "stt_auth_failed" });

    if (saved !== undefined) process.env.SONIOX_API_KEY = saved;
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

  test("language hints are forwarded into the config frame", async () => {
    const { ws, session } = await openSession({ languageHints: ["en", "es"] });
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

  test("close() removes the socket listeners so their closures can be freed", async () => {
    const { session, ws } = await openSession();
    expect(ws.listenerCount()).toBeGreaterThan(0);
    await session.close();
    expect(ws.listenerCount()).toBe(0);
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

    const pcm = new Int16Array([1, 2, 3, 4]);
    session.sendAudio(pcm);

    expect(ws.sent.length).toBe(before + 1);
    const sent = ws.sent.at(-1);
    expect(sent).toBeInstanceOf(Uint8Array);
    expect((sent as Uint8Array).byteLength).toBe(pcm.byteLength);
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
