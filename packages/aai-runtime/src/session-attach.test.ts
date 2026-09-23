// Copyright 2026 the AAI authors. MIT license.
/**
 * The transport-neutral session lifecycle, driven with no socket at all.
 *
 * `ws-handler*.test.ts` still pins every one of these behaviours through the
 * WebSocket adapter; this suite states them against the core, which is what a
 * non-socket adapter (`runtime.connect`, the console) is built on.
 */

import type { SessionEvent } from "@alexkroman1/aai";
import { createOwnedMap } from "@alexkroman1/aai/internal";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { makeClientSink, makeMockCore, silentLogger } from "./_test-utils.ts";
import { type AttachSessionOptions, attachSession } from "./session-attach.ts";
import type { ServerSession } from "./session-core.ts";

const readyConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function attach(core: ServerSession, overrides: Partial<AttachSessionOptions> = {}) {
  const client = makeClientSink({ close: vi.fn() });
  const sessions = createOwnedMap<string, ServerSession>();
  const attached = attachSession(client, {
    sessions,
    createSession: () => core,
    readyConfig,
    logger: silentLogger,
    ...overrides,
  });
  return { attached, client, sessions };
}

function events(client: ClientSink): SessionEvent[] {
  return (client.event as ReturnType<typeof vi.fn>).mock.calls.map(([e]) => e as SessionEvent);
}

describe("attachSession", () => {
  test("creates, claims and configures the session synchronously", () => {
    const core = makeMockCore();
    const { attached, sessions } = attach(core);

    expect(sessions.get(attached.id)).toBe(core);
    expect(core.configure).toHaveBeenCalledWith(readyConfig);
    expect(core.start).toHaveBeenCalledTimes(1);
  });

  test("input during start is buffered, then replayed in order once ready", async () => {
    const start = deferred();
    const core = makeMockCore({ start: vi.fn(() => start.promise) });
    const { attached } = attach(core);

    attached.sendAudio(new Uint8Array([1, 2]));
    attached.sendCommand({ type: "audio_ready" });
    expect(core.onAudio).not.toHaveBeenCalled();
    expect(core.command).not.toHaveBeenCalled();

    start.resolve();
    await vi.waitFor(() => expect(core.command).toHaveBeenCalledWith({ type: "audio_ready" }));
    expect(core.onAudio).toHaveBeenCalledWith(new Uint8Array([1, 2]));
  });

  test("a zero-length audio frame is not audio", async () => {
    const core = makeMockCore();
    const { attached } = attach(core);
    await vi.waitFor(() => expect(core.start).toHaveBeenCalled());
    await Promise.resolve();

    attached.sendAudio(new Uint8Array(0));
    attached.sendAudio(new Uint8Array([7]));

    await vi.waitFor(() => expect(core.onAudio).toHaveBeenCalledTimes(1));
    expect(core.onAudio).toHaveBeenCalledWith(new Uint8Array([7]));
  });

  test("an invalid command is dropped without reaching the session", async () => {
    const core = makeMockCore();
    const { attached } = attach(core);
    await Promise.resolve();
    await Promise.resolve();

    attached.sendCommand({ type: "playback_progress", bufferedMs: -5 });
    attached.sendCommand({ type: "a-newer-command" });
    attached.sendCommand({ type: "cancel" });

    await vi.waitFor(() => expect(core.command).toHaveBeenCalledTimes(1));
    expect(core.command).toHaveBeenCalledWith({ type: "cancel" });
  });

  test("detach stops the session once, releases the claim, and settles `ended`", async () => {
    const core = makeMockCore();
    const onSessionEnd = vi.fn();
    const { attached, client, sessions } = attach(core, { onSessionEnd });
    await Promise.resolve();

    attached.detach({ reason: "bye" });
    attached.detach();
    await attached.ended;

    expect(core.stop).toHaveBeenCalledTimes(1);
    expect(sessions.get(attached.id)).toBeUndefined();
    expect(onSessionEnd).toHaveBeenCalledWith(attached.id, client);
  });

  test("a failed start tells the client, closes it, and still ends the session", async () => {
    const core = makeMockCore({ start: vi.fn(() => Promise.reject(new Error("no provider"))) });
    const { attached, client } = attach(core);

    await attached.ended;

    expect(core.stop).toHaveBeenCalledTimes(1);
    expect(events(client).at(-1)).toMatchObject({
      type: "error.reported",
      code: "internal",
      fatal: true,
    });
    expect(client.close).toHaveBeenCalledWith("session start failed");
  });

  test("closeAfterFailure replaces the default close", async () => {
    const core = makeMockCore({ start: vi.fn(() => Promise.reject(new Error("x"))) });
    const closeAfterFailure = vi.fn();
    const { attached, client } = attach(core, { closeAfterFailure });

    await attached.ended;

    expect(closeAfterFailure).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
  });

  test("a createSession that throws reports the failure and ends at once", async () => {
    const client = makeClientSink({ close: vi.fn() });
    const attached = attachSession(client, {
      sessions: createOwnedMap(),
      createSession: () => {
        throw new Error("unregistered transport");
      },
      readyConfig,
      logger: silentLogger,
    });

    await attached.ended;

    expect(events(client)).toEqual([
      expect.objectContaining({ type: "error.reported", message: "Failed to start session" }),
    ]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("resuming a live id closes the superseded client and stops its session", () => {
    const sessions = createOwnedMap<string, ServerSession>();
    const oldCore = makeMockCore();
    const oldClient = makeClientSink({ close: vi.fn() });
    const first = attachSession(oldClient, {
      sessions,
      createSession: () => oldCore,
      readyConfig,
      logger: silentLogger,
    });

    const newCore = makeMockCore();
    attachSession(makeClientSink(), {
      sessions,
      createSession: () => newCore,
      readyConfig,
      logger: silentLogger,
      resumeFrom: first.id,
    });

    expect(sessions.get(first.id)).toBe(newCore);
    expect(oldClient.close).toHaveBeenCalledWith("session resumed by another connection");
    expect(oldCore.stop).toHaveBeenCalled();
  });
});
