// Copyright 2026 the AAI authors. MIT license.
/**
 * `executeConsole`'s orchestration, with the agent loader and the runtime
 * faked: which devices open at which rates, that `audio_ready` releases the
 * greeting, and that every way the session ends tears the devices down and
 * reports the right result. The session itself is `runtime.connect`'s, and is
 * specced in `aai-runtime`.
 */

import type { ClientSink } from "@alexkroman1/aai/protocol";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConsoleAudio } from "./_console-session.ts";

const state = vi.hoisted(() => ({
  sink: undefined as ClientSink | undefined,
  resolveEnded: undefined as (() => void) | undefined,
  connection: undefined as
    | { sendCommand: ReturnType<typeof vi.fn>; sendAudio: ReturnType<typeof vi.fn> }
    | undefined,
  shutdown: vi.fn(() => Promise.resolve()),
  page: undefined as string | undefined,
}));

vi.mock("./_dev-server.ts", () => ({
  loadWorker: vi.fn(async () => ({ name: "Desk", page: state.page })),
  resolveAgentEnv: vi.fn(async () => ({})),
}));

vi.mock("@alexkroman1/aai-runtime", () => ({
  withHostCredentialFallback: (env: Record<string, string>) => env,
  ensureSessionStateSchema: vi.fn(),
  ensureWorkflowJournalSchema: vi.fn(),
  createRuntime: vi.fn(() => ({
    readyConfig: { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
    shutdown: state.shutdown,
    connect: vi.fn((sink: ClientSink) => {
      state.sink = sink;
      const ended = new Promise<void>((resolve) => {
        state.resolveEnded = resolve;
      });
      const connection = {
        id: "sess-1",
        sendCommand: vi.fn(),
        sendAudio: vi.fn(),
        close: vi.fn(() => state.resolveEnded?.()),
        ended,
      };
      state.connection = connection;
      return connection;
    }),
  })),
}));

const { executeConsole, terminalPrinter } = await import("./console.ts");

/** A quit the user never asks for — the session has to end it. */
const never = (): Promise<void> => new Promise(() => undefined);

function fakeAudio() {
  const capture = { stop: vi.fn() };
  const player = { write: vi.fn(), flush: vi.fn(), stop: vi.fn() };
  const audio: ConsoleAudio = {
    startCapture: vi.fn(() => capture),
    startPlayback: vi.fn(() => player),
  };
  return { audio, capture, player };
}

beforeEach(() => {
  state.sink = undefined;
  state.page = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

describe("executeConsole", () => {
  test("opens both devices at the session's rates and releases the greeting", async () => {
    const { audio, capture, player } = fakeAudio();
    let quit!: () => void;
    const untilQuit = new Promise<void>((resolve) => {
      quit = resolve;
    });

    const run = executeConsole({ cwd: "/p", audio, untilQuit, mode: "json" });
    await vi.waitFor(() => expect(state.connection).toBeDefined());

    expect(audio.startPlayback).toHaveBeenCalledWith(24_000, expect.any(Function));
    expect(audio.startCapture).toHaveBeenCalledWith(
      16_000,
      expect.any(Function),
      expect.any(Function),
    );
    expect(state.connection?.sendCommand).toHaveBeenCalledWith({ type: "audio_ready" });

    quit();
    const result = await run;
    expect(result).toEqual({ ok: true, data: { sessionId: "sess-1" } });
    expect(capture.stop).toHaveBeenCalled();
    expect(player.stop).toHaveBeenCalled();
    expect(state.shutdown).toHaveBeenCalled();
  });

  test("a fatal session error ends the console as a failure", async () => {
    const { audio, player } = fakeAudio();
    const run = executeConsole({
      cwd: "/p",
      audio,
      untilQuit: never(),
      mode: "json",
    });
    await vi.waitFor(() => expect(state.sink).toBeDefined());

    state.sink?.event({
      type: "error.reported",
      code: "tts",
      message: "bad key",
      fatal: true,
      meta: { id: "e", at: 0 },
    });

    expect(await run).toMatchObject({ ok: false, code: "session_failed", error: "bad key" });
    expect(player.stop).toHaveBeenCalled();
  });

  test("a device failure ends the console and names the device error", async () => {
    const { audio } = fakeAudio();
    let fail!: (err: Error) => void;
    vi.mocked(audio.startCapture).mockImplementation((_rate, _chunk, onError) => {
      fail = onError;
      return { stop: vi.fn() };
    });
    const run = executeConsole({
      cwd: "/p",
      audio,
      untilQuit: never(),
      mode: "json",
    });
    await vi.waitFor(() => expect(fail).toBeDefined());

    fail(new Error("install sox"));

    expect(await run).toMatchObject({ ok: false, code: "audio_device", error: "install sox" });
  });

  test("a workflow app is refused before any device opens", async () => {
    state.page = "static";
    const { audio } = fakeAudio();
    const result = await executeConsole({ cwd: "/p", audio, untilQuit: Promise.resolve() });
    expect(result).toMatchObject({ ok: false, code: "not_a_voice_agent" });
    expect(audio.startPlayback).not.toHaveBeenCalled();
  });
});

describe("terminalPrinter", () => {
  test("marks an interrupted reply and a fatal error", () => {
    const lines: string[] = [];
    const print = terminalPrinter((line) => lines.push(line));
    print.user("hi");
    print.agent("hello", true);
    print.tool("lookup", { id: 1 });
    print.error("boom", true);
    const text = lines.join("\n");
    expect(text).toContain("hi");
    expect(text).toContain("[interrupted]");
    expect(text).toContain('lookup({"id":1})');
    expect(text).toContain("error: boom");
  });
});
